import { useEffect, useMemo, useRef } from 'react'
import { toast } from 'sonner'
import { useShallow } from 'zustand/react/shallow'
import {
  completePluginAppThemeTokens,
  type PluginThemeRegistration
} from '../../../../shared/plugins/artifacts/plugin-theme-artifact'
import type { ThemeStudioMode } from '../../../../shared/theme-studio/theme-studio-draft'
import type { ThemeStudioPreview } from '../../../../shared/theme-studio/theme-studio-protocol'
import type { AppThemePaint } from './document-theme'
import { browserColorProbe } from './plugin-theme-tokens'
import { themeBuiltInTokens } from './theme-built-in-tokens'
import { themeStudioReport } from './theme-studio-report'
import { installThemeStudioBridge, sendThemeStudioUserAction } from './theme-studio-bridge'
import { ThemeStudioNotice } from './ThemeStudioNotice'
import { useAppStore } from '@/store/index'
import { useThemeStudioPreviewStore } from '@/store/appearance/theme-studio-preview-store'

const NOTICE_ID = 'theme-studio-preview'

export type ThemeStudioPaint = AppThemePaint & Pick<PluginThemeRegistration, 'tokenColors'>

function showNotice(preview: NonNullable<ThemeStudioPreview>): void {
  const { last } = preview
  toast.custom(
    () => (
      <ThemeStudioNotice
        name={preview.draft.name}
        {...(last?.label ? { label: last.label } : {})}
        {...(last?.by ? { by: last.by } : {})}
        {...(last?.autoFixed ? { autoFixed: last.autoFixed } : {})}
        canUndo={preview.canUndo === true}
        onKeep={() => sendThemeStudioUserAction('keep')}
        onUndo={() => sendThemeStudioUserAction('undo')}
        onDiscard={() => sendThemeStudioUserAction('discard')}
      />
    ),
    { id: NOTICE_ID, duration: Number.POSITIVE_INFINITY, unstyled: true, closeButton: false }
  )
}

/** Picking a theme in Settings while a draft is open ends it, as Discard would. */
function useEndOnThemePick(active: boolean): void {
  const slots = useAppStore(
    useShallow((s) => [
      s.settings?.pluginAppThemeDark ?? null,
      s.settings?.pluginAppThemeLight ?? null,
      s.settings?.terminalThemeDark ?? null,
      s.settings?.terminalThemeLight ?? null
    ])
  )
  const seen = useRef(slots)
  useEffect(() => {
    const changed = seen.current.some((slot, index) => slot !== slots[index])
    seen.current = slots
    if (active && changed) {
      sendThemeStudioUserAction('ended')
    }
  }, [active, slots])
}

/**
 * The draft's app theme for the painted mode, or null, and the notice that lets the person keep,
 * undo or drop it. Costs nothing without a draft.
 */
export function useThemeStudioAppTheme(dark: boolean): {
  paint: ThemeStudioPaint | null
  preview: ThemeStudioPreview
} {
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
    if (preview) {
      showNotice(preview)
    } else {
      toast.dismiss(NOTICE_ID)
    }
  }, [preview])
  useEndOnThemePick(preview !== null)
  return { paint, preview }
}

/** Sends main the draft's contrast check for both modes and what this paint actually dropped. */
export function reportThemeStudioPaint(
  preview: NonNullable<ThemeStudioPreview>,
  mode: ThemeStudioMode,
  attempted: Readonly<Record<string, string>> | null,
  painted: Readonly<Record<string, string>>,
  editorPinned: boolean
): void {
  window.api?.themeStudio?.report({
    ...themeStudioReport({
      revision: preview.revision,
      draft: preview.draft,
      shownMode: mode,
      builtIns: themeBuiltInTokens,
      probe: browserColorProbe
    }),
    paint: {
      mode,
      dropped: attempted ? Object.keys(attempted).filter((token) => !(token in painted)) : [],
      editor: editorPinned ? 'pinned' : 'follows-app'
    }
  })
}
