import type { GlobalSettings } from '../shared/global-settings-types'

// Under main authority, copying fabricated bytes would create renderer ACKs for unmetered data.
export function shouldCopySyntheticTitleFrameToPtyData(
  settings: Pick<GlobalSettings, 'terminalMainSideEffectAuthority'> | null | undefined
): boolean {
  return settings?.terminalMainSideEffectAuthority === false
}
