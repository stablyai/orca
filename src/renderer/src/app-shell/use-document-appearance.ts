import { useEffect, useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { buildAppFontFamily } from '@/app-shell/appearance/app-font-family'
import { applyCodeFontSmoothing } from '@/lib/editor/appearance/code-font-smoothing'
import { applyMarkdownCodeFontFamily } from '@/lib/editor/appearance/markdown-code-font'
import { useSplitDividerSetting } from '@/hooks/use-split-divider-setting'
import { rebuildAllTerminalWebglRenderers } from '@/lib/pane-manager/pane-manager-registry'
import { applyThemeBackground } from './appearance/theme-background'
import { syncThemeBackgroundVideo } from './appearance/theme-background-video'
import { usePrefersReducedMotion } from '../hooks/usePrefersReducedMotion'
import { useWindowActive } from '../hooks/use-window-active'
import { tolerantPluginThemeBackgroundRegistration } from '../../../shared/plugins/artifacts/plugin-theme-background'
import {
  findCodeEditorTheme,
  paintCodeEditorColors,
  resolveCodeEditorTheme
} from '../lib/editor/appearance/code-editor-theme'
import { browserColorProbe } from './appearance/plugin-theme-tokens'
import {
  TINTED_HOST_PILL_OUTLINE_MIX_TOKEN,
  tintedSidebarHostPillOutlineMix
} from './appearance/left-sidebar-appearance'
import { useCodeEditorThemeStore } from '../store/appearance/code-editor-theme'
import { useAppThemePaint } from './appearance/use-app-theme-paint'
import {
  usePluginAppThemeSync,
  usePluginTerminalPaletteRefresh
} from '../store/plugins/appearance/plugin-themes'
import { usePluginIconThemeActivation } from '../store/plugins/appearance/plugin-icon-themes'
import { usePluginFontRegistration } from '../store/plugins/appearance/plugin-fonts'
import { scheduleRuntimeGraphSync } from '../runtime/sync-runtime-graph/graph-sync-scheduler'
import { useAppStore } from '../store'
import { useReduceVisualEffects } from '@/hooks/use-reduce-visual-effects'

export function useDocumentAppearance(): void {
  const {
    theme,
    dark,
    requestedDark,
    appTheme,
    pluginTheme,
    pluginThemes,
    pluginThemesLoaded,
    ready,
    appPainted
  } = useAppThemePaint()
  const editorTheme = findCodeEditorTheme(
    useAppStore((s) => (dark ? s.settings?.editorThemeDark : s.settings?.editorThemeLight)),
    pluginThemes
  )
  usePluginTerminalPaletteRefresh()
  usePluginAppThemeSync()
  useSplitDividerSetting()
  const appFontFamily = useAppStore((s) => s.settings?.appFontFamily)
  const codeFontSmoothing = useAppStore((s) => s.settings?.codeFontSmoothing)
  const editorFontFamily = useAppStore((s) => s.settings?.editorFontFamily)
  usePluginIconThemeActivation(useAppStore((s) => s.settings?.pluginIconTheme))
  usePluginFontRegistration()
  const reduceEffects = useReduceVisualEffects(useAppStore((s) => s.settings?.reduceVisualEffects))
  const surfaceOpacity = useAppStore((s) => s.settings?.terminalBackgroundOpacity ?? 1)
  useEffect(() => {
    document.documentElement.style.setProperty(
      '--orca-window-surface-opacity',
      String(surfaceOpacity)
    )
  }, [surfaceOpacity])
  // Why re-parse: the theme list keeps the registration as received, and a newer host may send
  // a background this build cannot paint; it must drop to no image, never reach CSS.
  const registeredBackground = pluginTheme?.background
  const themeBackground = useMemo(
    () => tolerantPluginThemeBackgroundRegistration.parse(registeredBackground),
    [registeredBackground]
  )

  useEffect(() => {
    if (theme === 'system') {
      // System theme changes don't mutate the store, so mobile terminal colors need an explicit graph republish.
      scheduleRuntimeGraphSync()
    }
    // Why requestedDark: an OS flip can change the terminal palette without changing `dark`.
  }, [theme, dark, requestedDark])

  const sidebarTint = useAppStore(
    useShallow((s) =>
      s.settings
        ? {
            leftSidebarAppearanceMode: s.settings.leftSidebarAppearanceMode,
            leftSidebarTintColor: s.settings.leftSidebarTintColor,
            leftSidebarTintOpacity: s.settings.leftSidebarTintOpacity
          }
        : null
    )
  )
  // Why after useAppThemePaint: the tinted sidebar is the app's text and background as just painted
  // (ready too, since loading the list can replace the startup cache's colors).
  useEffect(() => {
    if (!theme) {
      return
    }
    const root = document.documentElement
    const computed = getComputedStyle(root)
    const outlineMix = tintedSidebarHostPillOutlineMix(
      sidebarTint,
      {
        foreground: computed.getPropertyValue('--foreground').trim(),
        background: computed.getPropertyValue('--background').trim(),
        base: dark ? 'dark' : 'light'
      },
      browserColorProbe
    )
    if (outlineMix === null) {
      root.style.removeProperty(TINTED_HOST_PILL_OUTLINE_MIX_TOKEN)
    } else {
      root.style.setProperty(TINTED_HOST_PILL_OUTLINE_MIX_TOKEN, `${outlineMix}%`)
    }
  }, [appTheme, ready, theme, dark, sidebarTint])

  // Why gated: the image only shows through translucent terminals and chats, so otherwise it would
  // cost decode and switch terminals to transparent rendering for nothing.
  const paintsBackground = surfaceOpacity < 1 && !reduceEffects
  useEffect(() => {
    if (pluginThemesLoaded) {
      applyThemeBackground(paintsBackground ? themeBackground : null, surfaceOpacity)
    }
  }, [pluginThemesLoaded, paintsBackground, surfaceOpacity, themeBackground])

  const reduceMotion = usePrefersReducedMotion()
  const video =
    paintsBackground && !reduceMotion && themeBackground?.videoUrl ? themeBackground : null
  // Why only while active: each frame costs a decode and a window composite, even unfocused.
  const windowActive = useWindowActive(video !== null)
  useEffect(() => {
    if (pluginThemesLoaded) {
      syncThemeBackgroundVideo(video, windowActive)
    }
  }, [pluginThemesLoaded, video, windowActive])

  // Why after useAppThemePaint: a followed editor reads the colors it just painted. Built-in
  // choices resolve before the plugin list loads; a plugin choice follows the app until then.
  useEffect(() => {
    if (!theme) {
      return
    }
    const computed = getComputedStyle(document.documentElement)
    const codeEditorTheme = resolveCodeEditorTheme({
      dark,
      appTheme,
      selected: editorTheme,
      appPainted: appPainted.current,
      readDocument: (token) => computed.getPropertyValue(token),
      probe: browserColorProbe
    })
    paintCodeEditorColors(codeEditorTheme.override)
    useCodeEditorThemeStore.setState(codeEditorTheme)
  }, [appTheme, appPainted, editorTheme, pluginThemesLoaded, theme, dark])

  useEffect(() => {
    document.documentElement.style.setProperty(
      '--app-font-family',
      buildAppFontFamily(appFontFamily)
    )
  }, [appFontFamily])

  useEffect(() => {
    applyMarkdownCodeFontFamily(editorFontFamily)
  }, [editorFontFamily])

  useEffect(() => {
    // WebGL glyph atlases keep the smoothing they were created with; rebuild only on a real change.
    if (applyCodeFontSmoothing(codeFontSmoothing)) {
      rebuildAllTerminalWebglRenderers('code-font-smoothing')
    }
  }, [codeFontSmoothing])
}
