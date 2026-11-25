import type { PluginViewColorScheme } from '../../../shared/plugins/view/plugin-view-protocol'

export const PLUGIN_SHOT_VISIBLE_THEME_REASON =
  'the Orca window is visible; capturing in the current theme so the app is not repainted'

/** `--theme` repaints the whole app, so it only applies while nobody can see the window. */
export function pluginShotThemeDecision(
  requested: PluginViewColorScheme | undefined,
  windowShown: boolean
): { colorScheme?: PluginViewColorScheme; themeReason?: string } {
  if (requested === undefined) {
    return {}
  }
  return windowShown
    ? { themeReason: PLUGIN_SHOT_VISIBLE_THEME_REASON }
    : { colorScheme: requested }
}

/** Shown means on screen: a hidden or minimized window is painted for the capture only. */
export function isPluginShotWindowShown(window: {
  isDestroyed(): boolean
  isVisible(): boolean
  isMinimized(): boolean
}): boolean {
  return !window.isDestroyed() && window.isVisible() && !window.isMinimized()
}

export const PLUGIN_SHOT_ACT_WINDOW_SHOWN_MESSAGE =
  "shot --act needs Orca's window hidden or minimized, so it never clicks under the user"

/** `--act` drives a components panel, and only while nobody can be using the window. */
export function pluginShotActRefusal(
  ui: 'components' | 'html',
  windowShown: boolean
): { reason: string; message: string; nextSteps: string[] } | null {
  if (ui !== 'components') {
    return {
      reason: 'act_unsupported',
      message: 'shot --act drives components panels only; this panel is html.',
      nextSteps: ['Drive an html panel from its own page script, then run shot without --act.']
    }
  }
  return windowShown
    ? {
        reason: 'window_shown',
        message: PLUGIN_SHOT_ACT_WINDOW_SHOWN_MESSAGE,
        nextSteps: ['Minimize or hide Orca, then run this again.']
      }
    : null
}

export const PLUGIN_SHOT_REPLAY_WINDOW_SHOWN_MESSAGE =
  "shot --scenario draws its preview inside Orca's window, so it needs the window hidden or minimized"

/** The preview is drawn over the window's own content, so only while nobody can see it. */
export function pluginShotReplayRefusal(
  windowShown: boolean
): { reason: string; message: string; nextSteps: string[] } | null {
  return windowShown
    ? {
        reason: 'window_shown',
        message: PLUGIN_SHOT_REPLAY_WINDOW_SHOWN_MESSAGE,
        nextSteps: [
          'Minimize or hide Orca, then run this again; `orca plugin check` renders the same scenarios as text.'
        ]
      }
    : null
}
