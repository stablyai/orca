import { useEffect, useMemo } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import {
  completePluginAppThemeTokens,
  type PluginThemeRegistration
} from '../../../../shared/plugins/artifacts/plugin-theme-artifact'
import type { ThemeStudioMode } from '../../../../shared/theme-studio/theme-studio-draft'
import {
  themeStudioPreviewSchema,
  type ThemeStudioPreview,
  type ThemeStudioReply,
  type ThemeStudioRequest
} from '../../../../shared/theme-studio/theme-studio-protocol'
import type { AppThemePaint } from './document-theme'
import { browserColorProbe } from './plugin-theme-tokens'
import { themeBuiltInTokens } from './theme-built-in-tokens'
import { themeStudioReport } from './theme-studio-report'
import { resolveThemeStudioModes } from './theme-studio-resolve'
import { getSystemPrefersDark } from '@/lib/terminal/appearance/terminal-theme'
import { applyPluginThemesNow } from '@/components/plugins/state/plugin-theme-apply'
import { useAppStore } from '@/store/index'
import { usePluginThemeStore } from '@/store/plugins/appearance/plugin-themes'
import { useThemeStudioPreviewStore } from '@/store/appearance/theme-studio-preview-store'

const PREVIEW_TOAST_ID = 'theme-studio-preview'

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

function installThemeStudioBridge(): void {
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

function showPreviewToast(preview: NonNullable<ThemeStudioPreview>): void {
  const act = (action: 'keep' | 'discard') => () =>
    window.api?.themeStudio?.userAction({ action, revision: preview.revision })
  toast(
    translate('auto.app-shell.themeStudio.previewing', 'Previewing {{value0}}', {
      value0: preview.draft.name
    }),
    {
      id: PREVIEW_TOAST_ID,
      duration: Number.POSITIVE_INFINITY,
      description: translate(
        'auto.app-shell.themeStudio.previewHint',
        'An agent is editing this theme. Keep saves it as one of your themes.'
      ),
      action: { label: translate('auto.app-shell.themeStudio.keep', 'Keep'), onClick: act('keep') },
      cancel: {
        label: translate('auto.app-shell.themeStudio.discard', 'Discard'),
        onClick: act('discard')
      }
    }
  )
}

/**
 * The draft's app theme for the painted mode, or null. Also reports each painted revision's
 * contrast check to main and keeps the preview toast current. Costs nothing without a draft.
 */
export function useThemeStudioAppTheme(
  dark: boolean
): (AppThemePaint & Pick<PluginThemeRegistration, 'tokenColors'>) | null {
  useEffect(installThemeStudioBridge, [])
  const preview = useThemeStudioPreviewStore((state) => state.preview)
  const mode: ThemeStudioMode = dark ? 'dark' : 'light'
  const variant = preview?.draft[mode] ?? null
  const revision = preview?.revision
  const paint = useMemo(
    () =>
      variant && revision !== undefined
        ? {
            id: `theme-studio:${mode}`,
            revision: String(revision),
            base: mode,
            tokens: completePluginAppThemeTokens(variant.tokens),
            tokenColors: variant.tokenColors ?? []
          }
        : null,
    [variant, revision, mode]
  )
  useEffect(() => {
    if (!preview) {
      toast.dismiss(PREVIEW_TOAST_ID)
      return
    }
    showPreviewToast(preview)
    window.api?.themeStudio?.report(
      themeStudioReport({
        revision: preview.revision,
        draft: preview.draft,
        shownMode: mode,
        builtIns: themeBuiltInTokens,
        probe: browserColorProbe
      })
    )
  }, [preview, mode])
  return paint
}
