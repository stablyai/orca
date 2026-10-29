import { join } from 'node:path'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import { DelayedAuthority } from '../loading-store/profile-state-delayed-authority-fixture'
import { Store } from '../loading-store/store'
import { buildProfileStateCutoverFixture } from '../profile-state-cutover-fixture'
import { ProfileStateSqliteAuthority } from '../profile-state/profile-state-sqlite-authority'

// Register this fixture repo so load pruning preserves its workspace.
export const FIXTURE_GIT_WORKTREE_ID = 'repo-local::/fixture/local'
export const FIXTURE_FOLDER_WORKTREE_ID = 'repo-local::/fixture/local::workspace:folder-1'

export function emptyTerminalSessionProfile(): string {
  const state = buildProfileStateCutoverFixture()
  return JSON.stringify({
    ...state,
    // Avoid random load-minted IDs in persistence comparisons.
    settings: {
      ...state.settings,
      telemetry: { existedBeforeTelemetryRelease: true, optedIn: null, installId: 'install-1' }
    },
    workspaceSession: getDefaultWorkspaceSession(),
    workspaceSessionsByHostId: {}
  })
}

export async function openTopologyStore(directory: string, seed?: string): Promise<Store> {
  return (await openTopologyStoreWithAuthority(directory, seed)).store
}

/** Expose authority so tests can inject write failures. */
export async function openTopologyStoreWithAuthority(
  directory: string,
  seed?: string
): Promise<{ store: Store; authority: DelayedAuthority }> {
  const inner = new ProfileStateSqliteAuthority(join(directory, 'profile-state.db'), 'topology')
  if (seed) {
    inner.writeSerializedState(Buffer.from(seed))
  }
  const authority = new DelayedAuthority(inner)
  const store = new Store({
    dataFile: join(directory, 'orca-data.json'),
    profileStateAuthority: authority
  })
  await store.flushPendingOrThrowAsync()
  return { store, authority }
}

/** Drain, close and cold-load to model relaunch. */
export async function reopenTopologyStore(store: Store, directory: string): Promise<Store> {
  await store.flushPendingOrThrowAsync()
  await store.freezeWritesAsync()
  return openTopologyStore(directory)
}
