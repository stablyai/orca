// TEAM-SHARING hold: team workspace sharing ships in a later release. TEAM_SHARING=on turns it on; anything else
// (the default) holds it. While held, a workspace stored as `team` acts private everywhere access is decided
// (owner only, plus org admins' metadata as before): the column and its data stay, so turning it on restores
// each workspace's own setting. Set from the Worker's env at the start of every request and scheduled run (the
// same value for the whole isolate: no per-request state).
import type { SandboxRow } from './store'

let enabled = false

export function configureTeamSharing(env: { TEAM_SHARING?: string }): void {
  enabled = env.TEAM_SHARING === 'on'
}

export function teamSharingEnabled(): boolean {
  return enabled
}

/** The visibility access rules use: the stored one with sharing on, else always private. */
export function effectiveVisibility(row: Pick<SandboxRow, 'visibility'>): 'private' | 'team' {
  return enabled && row.visibility === 'team' ? 'team' : 'private'
}
