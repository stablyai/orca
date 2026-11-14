import type { GlobalSettings } from '../../../../shared/global-settings-types'
import {
  themeStudioPreviewSchema,
  type ThemeStudioReply,
  type ThemeStudioRequest,
  type ThemeStudioUserAction
} from '../../../../shared/theme-studio/theme-studio-protocol'
import { resolveThemeStudioModes } from './theme-studio-resolve'
import { getSystemPrefersDark } from '@/lib/terminal/appearance/terminal-theme'
import { applyPluginThemes } from '@/components/plugins/state/plugin-theme-apply'
import { useAppStore } from '@/store/index'
import { usePluginThemeStore } from '@/store/plugins/appearance/plugin-themes'
import { useThemeStudioPreviewStore } from '@/store/appearance/theme-studio-preview-store'

const MAX_RESTORE_POINTS = 8
// Why kept here: the settings a save replaced stay in this window, and main holds only a token.
const restorePoints = new Map<string, Partial<GlobalSettings>>()
let nextRestorePoint = 0

function rememberRestorePoint(previous: Partial<GlobalSettings>): string {
  const token = `restore-${(nextRestorePoint += 1)}`
  restorePoints.set(token, previous)
  const oldest = restorePoints.keys().next().value
  if (restorePoints.size > MAX_RESTORE_POINTS && oldest !== undefined) {
    restorePoints.delete(oldest)
  }
  return token
}

async function answer(request: ThemeStudioRequest): Promise<ThemeStudioReply> {
  const { requestId } = request
  if (request.kind === 'select') {
    const previous = await applyPluginThemes(request.pluginKey)
    return {
      requestId,
      ok: true,
      selected: previous !== null,
      ...(previous ? { previous: { restorePoint: rememberRestorePoint(previous) } } : {})
    }
  }
  if (request.kind === 'restore') {
    const token = request.settings.restorePoint
    const previous = typeof token === 'string' ? restorePoints.get(token) : undefined
    if (!previous) {
      throw new Error('This window no longer has the theme to go back to.')
    }
    await useAppStore.getState().updateSettings(previous)
    return { requestId, ok: true }
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
      useThemeStudioPreviewStore.setState({ preview: parsed.data })
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
