import { join } from 'node:path'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import { DelayedAuthority } from '../loading-store/profile-state-delayed-authority-fixture'
import { Store } from '../loading-store/store'
import { buildProfileStateCutoverFixture } from '../profile-state-cutover-fixture'
import { ProfileStateSqliteAuthority } from '../profile-state/profile-state-sqlite-authority'

/** A worktree of the fixture's registered repo, so load keeps its rows. */
export const FIXTURE_GIT_WORKTREE_ID = 'repo-local::/fixture/local'
export const FIXTURE_FOLDER_WORKTREE_ID = 'repo-local::/fixture/local::workspace:folder-1'

/** The cutover fixture profile with no terminal session yet. */
export function emptyTerminalSessionProfile(): string {
  const state = buildProfileStateCutoverFixture()
  return JSON.stringify({
    ...state,
    // A fixed install id: load mints a random one when it is missing.
    settings: {
      ...state.settings,
      telemetry: { existedBeforeTelemetryRelease: true, optedIn: null, installId: 'install-1' }
    },
    workspaceSession: getDefaultWorkspaceSession(),
    workspaceSessionsByHostId: {}
  })
}

/** Opens a real Store on SQLite in `directory`, seeding it first when `seed` is given. */
export async function openTopologyStore(directory: string, seed?: string): Promise<Store> {
  const inner = new ProfileStateSqliteAuthority(join(directory, 'profile-state.db'), 'topology')
  if (seed) {
    inner.writeSerializedState(Buffer.from(seed))
  }
  const store = new Store({
    dataFile: join(directory, 'orca-data.json'),
    profileStateAuthority: new DelayedAuthority(inner)
  })
  await store.flushPendingOrThrowAsync()
  return store
}

/** Quit and relaunch: drain pending writes, close, and load the profile cold. */
export async function reopenTopologyStore(store: Store, directory: string): Promise<Store> {
  await store.flushPendingOrThrowAsync()
  await store.freezeWritesAsync()
  return openTopologyStore(directory)
}
