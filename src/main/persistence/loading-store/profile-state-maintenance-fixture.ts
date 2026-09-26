import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, vi } from 'vitest'
import { buildProfileStateCutoverFixture } from '../profile-state-cutover-fixture'
import { ProfileStateSqliteAuthority } from '../profile-state/profile-state-sqlite-authority'
import { ProfileStateWorkerAuthority } from '../profile-state/profile-state-worker-authority'
import { Store } from './store'

let bundleRoot: string
let workerOptions: { workerPath: string; backupWorkerPath: string }
const stores: Store[] = []
const roots: string[] = []
const releases: (() => void)[] = []
type ProfileFixtureLocation = { directory: string; profileId: string; cleanupRoot?: string }

beforeAll(async () => {
  bundleRoot = mkdtempSync(join(tmpdir(), 'orca-maintenance-worker-'))
  workerOptions = {
    workerPath: join(bundleRoot, 'profile-state-writer-worker-entry.js'),
    backupWorkerPath: join(bundleRoot, 'profile-state-backup-worker-entry.js')
  }
  await build({
    entryPoints: [
      resolve('src/main/persistence/profile-state/profile-state-writer-worker-entry.ts'),
      resolve('src/main/persistence/profile-state/profile-state-backup-worker-entry.ts')
    ],
    outdir: bundleRoot,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    logLevel: 'silent'
  })
})

afterEach(async () => {
  for (const release of releases.splice(0)) {
    release()
  }
  await Promise.all(stores.splice(0).map((store) => store.freezeWritesAsync().catch(() => {})))
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
  vi.restoreAllMocks()
  vi.useRealTimers()
})
afterAll(() => rmSync(bundleRoot, { recursive: true, force: true }))

export function maintenanceBarrier() {
  const gate = Promise.withResolvers<void>()
  releases.push(gate.resolve)
  return gate
}

function paths(profile?: ProfileFixtureLocation) {
  const directory = profile?.directory ?? mkdtempSync(join(tmpdir(), 'orca-maintenance-profile-'))
  roots.push(profile?.cleanupRoot ?? directory)
  return {
    directory,
    dataFile: join(directory, 'orca-data.json'),
    databaseFile: join(directory, 'profile-state.db'),
    profileId: profile?.profileId ?? 'maintenance-test'
  }
}

export async function createWorkerMaintenanceFixture(
  profile?: ProfileFixtureLocation,
  onFailure?: (error: Error) => void
) {
  const input = paths(profile)
  const bootstrap = new ProfileStateSqliteAuthority(input.databaseFile, input.profileId)
  bootstrap.writeSerializedState(
    Buffer.from(JSON.stringify(buildProfileStateCutoverFixture(input.directory)))
  )
  const state = bootstrap.readInitialState().takeParsedState?.()
  const authority = new ProfileStateWorkerAuthority(bootstrap.retireForWorker(), {
    ...workerOptions,
    onFailure
  })
  await authority.ready
  const store = new Store({
    dataFile: input.dataFile,
    profileStateAuthority: authority,
    initialAuthorityState: { authority, takeParsedState: () => state }
  })
  stores.push(store)
  const backup = vi.spyOn(authority, 'scheduleBackup').mockImplementation(() => {})
  await store.flushPendingOrThrowAsync()
  backup.mockRestore()
  const peer = () => new ProfileStateSqliteAuthority(input.databaseFile, input.profileId)
  const readState = () => {
    const reader = peer()
    try {
      return JSON.parse(reader.readSerializedState() ?? '{}')
    } finally {
      reader.close()
    }
  }
  return { ...input, store, authority, peer, readState }
}

export function createSqliteMaintenanceFixture() {
  const input = paths()
  const authority = new ProfileStateSqliteAuthority(input.databaseFile, input.profileId)
  authority.writeSerializedState(
    Buffer.from(JSON.stringify(buildProfileStateCutoverFixture(input.directory)))
  )
  const store = new Store({ dataFile: input.dataFile, profileStateAuthority: authority })
  stores.push(store)
  return { ...input, store, authority }
}
