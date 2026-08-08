import { systemPreferences } from 'electron'

/**
 * macOS "Add period with double-space" (`NSAutomaticPeriodSubstitutionEnabled`, on by default)
 * is applied by AppKit's text input system. Native terminals never join that system; Chromium
 * text fields do, so xterm's helper textarea inherits it and a double space arrives as `". "` —
 * a period nobody typed, handed straight to the PTY (#11504).
 *
 * Chromium answers AppKit for quote and dash substitution and defaults both off (`boolForKey:`
 * on an unset `WebAutomatic*` key), which is why those never leak. It declares no period accessor
 * at all — "period" does not appear in render_widget_host_view_cocoa.mm — so AppKit applies that
 * one without asking, and this user default is the only lever. There is no per-field or
 * per-webContents opt-out to prefer over it.
 *
 * Writing the key into Orca's own defaults domain overrides the global value for this app alone
 * and leaves the user's system-wide setting untouched. It necessarily covers every Orca text
 * field, not only terminals — AppKit offers no narrower scope.
 */
export const AUTOMATIC_PERIOD_SUBSTITUTION_KEY = 'NSAutomaticPeriodSubstitutionEnabled'

export type DisableMacAutomaticPeriodSubstitutionOptions = {
  platform?: NodeJS.Platform
  setUserDefault?: (key: string, type: 'boolean', value: boolean) => void
}

/** Returns whether the app-domain override was written. No-op off macOS. */
export function disableMacAutomaticPeriodSubstitution({
  platform = process.platform,
  setUserDefault = (key, type, value) => systemPreferences.setUserDefault(key, type, value)
}: DisableMacAutomaticPeriodSubstitutionOptions = {}): boolean {
  if (platform !== 'darwin') {
    return false
  }

  try {
    setUserDefault(AUTOMATIC_PERIOD_SUBSTITUTION_KEY, 'boolean', false)
    return true
  } catch (error) {
    // Why: a preferences write is never worth failing startup over.
    console.warn('Failed to disable macOS automatic period substitution', error)
    return false
  }
}
