import type { GlobalSettings } from '../shared/types'

/**
 * Why: with the side-effect kill switch off, renderer byte parsers are the
 * ONLY consumer of main-fabricated OSC title frames, so they must still ride
 * `pty:data`. With main authority on (the default), the tracker ingest is the
 * sole consumer and the legacy copy would only mint phantom renderer ACKs for
 * bytes main never metered. See terminal-side-effect-authority.md (slice 3).
 */
export function shouldCopySyntheticTitleFrameToPtyData(
  settings: Pick<GlobalSettings, 'terminalMainSideEffectAuthority'> | null | undefined
): boolean {
  return settings?.terminalMainSideEffectAuthority === false
}
