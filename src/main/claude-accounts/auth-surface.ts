import { createHash } from 'node:crypto'

/**
 * Per-surface bookkeeping for Claude runtime auth. A "surface" is one set of
 * files Claude reads its identity from: the host `~/.claude`, or a WSL distro's
 * own `~/.claude`. Each surface tracks its own last-written state so a host and
 * a WSL switch cannot overwrite each other's ownership proofs.
 */
export type ClaudeAuthSurfaceState = {
  lastSyncedAccountId: string | null
  // Why: creds Orca last wrote to the shared file; a mismatch on managed→default transition means an external login overwrote it, so adopt it as the new default.
  lastWrittenCredentialsJson: string | null
  hasMaterializedRuntimeAuth: boolean
  hasLastWrittenOauthAccount: boolean
  lastWrittenOauthAccount: unknown
  skipNextReadBackForAccountId: string | null
}

export const HOST_AUTH_SURFACE_KEY = 'host'

// Why: Windows folds the distro segment of \\wsl.localhost paths, so `Ubuntu` and `ubuntu` must resolve to one surface.
export function wslAuthSurfaceKey(distro: string): string {
  return `wsl:${distro.trim().toLowerCase()}`
}

// Why: distro names are user-chosen at `wsl --import` and can contain characters illegal in Windows filenames; hashing avoids both invalid names and sanitizing collisions (`Ubuntu:1` vs `Ubuntu_1`).
export function authSurfaceSnapshotFileName(surfaceKey: string): string {
  if (surfaceKey === HOST_AUTH_SURFACE_KEY) {
    return 'system-default-auth.json'
  }
  const suffix = createHash('sha256').update(surfaceKey).digest('hex').slice(0, 8)
  return `system-default-auth-wsl-${suffix}.json`
}

export class ClaudeAuthSurfaceStates {
  private readonly states = new Map<string, ClaudeAuthSurfaceState>()

  /**
   * Why: a surface first seen after an app restart must adopt the persisted
   * selection, otherwise the restore branch never fires and deselecting leaves
   * Orca's credentials in place instead of the user's own login. The seed is a
   * callback because only the caller can prove Orca already materialized here —
   * claiming an unmaterialized selection would restore over an untouched login.
   */
  stateFor(
    surfaceKey: string,
    seedLastSyncedAccountId: () => string | null
  ): ClaudeAuthSurfaceState {
    const existing = this.states.get(surfaceKey)
    if (existing) {
      return existing
    }
    const created: ClaudeAuthSurfaceState = {
      lastSyncedAccountId: seedLastSyncedAccountId(),
      lastWrittenCredentialsJson: null,
      hasMaterializedRuntimeAuth: false,
      hasLastWrittenOauthAccount: false,
      lastWrittenOauthAccount: null,
      skipNextReadBackForAccountId: null
    }
    this.states.set(surfaceKey, created)
    return created
  }
}
