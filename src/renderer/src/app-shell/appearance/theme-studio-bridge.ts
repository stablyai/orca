import {
  themeStudioPreviewSchema,
  type ThemeStudioReply,
  type ThemeStudioRequest,
  type ThemeStudioUserAction
} from '../../../../shared/theme-studio/theme-studio-protocol'
import { resolveThemeStudioModes } from './theme-studio-resolve'
import { getSystemPrefersDark } from '@/lib/terminal/appearance/terminal-theme'
import { applyPluginThemesNow } from '@/components/plugins/state/plugin-theme-apply'
import { useAppStore } from '@/store/index'
import { usePluginThemeStore } from '@/store/plugins/appearance/plugin-themes'
import {
  setThemeStudioPreview,
  useThemeStudioPreviewStore
} from '@/store/appearance/theme-studio-preview-store'

async function answer(request: ThemeStudioRequest): Promise<ThemeStudioReply> {
  const { requestId } = request
  if (request.kind === 'select') {
    return { requestId, ok: true, selected: await applyPluginThemesNow(request.pluginKey) }
  }
  const { settings } = useAppStore.getState()
  if (!settings) {
    throw new Error('Orca is still loading its settings.')
  }
  const themes = await usePluginThemeStore.getState().fetchEntries()
  return {
    requestId,
    ok: true,
    resolved: resolveThemeStudioModes({
      settings,
      themes,
      systemPrefersDark: getSystemPrefersDark(),
      shownMode: document.documentElement.classList.contains('dark') ? 'dark' : 'light'
    })
  }
}

let bridgeInstalled = false

/** Listens for drafts and requests from main; once per window. */
export function installThemeStudioBridge(): void {
  const api = window.api?.themeStudio
  if (bridgeInstalled || typeof api?.onPreview !== 'function') {
    return
  }
  bridgeInstalled = true
  let pushed = false
  const accept = (raw: unknown): void => {
    const parsed = themeStudioPreviewSchema.safeParse(raw)
    if (parsed.success) {
      setThemeStudioPreview(parsed.data)
    }
  }
  api.onPreview((preview) => {
    pushed = true
    accept(preview)
  })
  api.onRequest((request) => {
    void answer(request)
      .catch((error: unknown): ThemeStudioReply => ({
        requestId: request.requestId,
        ok: false,
        message: error instanceof Error ? error.message : String(error)
      }))
      .then((reply) => api.reply(reply))
  })
  // Why only before a push: a push that lands first is newer than this answer.
  void api.current().then(
    (preview) => {
      if (!pushed) {
        accept(preview)
      }
    },
    () => undefined
  )
}

/** Tells main what the person did with the draft on screen. */
export function sendThemeStudioUserAction(action: ThemeStudioUserAction['action']): void {
  const revision = useThemeStudioPreviewStore.getState().preview?.revision
  if (revision !== undefined) {
    window.api?.themeStudio?.userAction({ action, revision })
  }
}
