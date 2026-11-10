import { build } from 'esbuild'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, vi } from 'vitest'
import type { Store } from '../loading-store/store'
import { ProfileStateSqliteAuthority } from './profile-state-sqlite-authority'
import { createLiveProfileStateStore } from './profile-state-live-store-factory'
import {
  createProfileStateStore,
  type ProfileStateStoreFactoryOptions
} from './profile-state-store-factory'
import { buildProfileStateCutoverFixture } from '../profile-state-cutover-fixture'
import {
  getOrcaProfileDataFile,
  getOrcaProfileStateDatabaseFile
} from '../../../shared/profile-state-storage-paths'
import { tabId, leafId } from '../loading-store/legacy-pty-restore-test-fixture'
import { ProfileStateWriteWorkerClient } from './profile-state-writer-worker-client'
import { deferred } from '../loading-store/profile-state-delayed-authority-fixture'
import { getOrcaProfileIndexPath } from '../../orca-profiles/profile-storage-paths'
import { ORCA_PROFILE_INDEX_SCHEMA_VERSION } from '../../../shared/orca-profiles'

let bundleRoot: string
let workerOptions: { workerPath: string; backupWorkerPath: string }
const roots: string[] = []
export const stores: Store[] = []

beforeAll(async () => {
  bundleRoot = mkdtempSync(join(tmpdir(), 'orca-live-writer-bundle-'))
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
  await Promise.all(stores.splice(0).map((store) => store.freezeWritesAsync()))
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
  vi.restoreAllMocks()
})
afterAll(() => rmSync(bundleRoot, { recursive: true, force: true }))

export function options() {
  const root = mkdtempSync(join(tmpdir(), 'orca-live-profile-'))
  roots.push(root)
  return {
    dataFile: join(root, 'orca-data.json'),
    databaseFile: join(root, 'profile-state.db'),
    profileId: 'live-profile-test'
  }
}

export async function open(input: ProfileStateStoreFactoryOptions) {
  const result = await createLiveProfileStateStore(input, workerOptions)
  stores.push(result.store)
  return result
}

export async function nestedProfiles(count = 1) {
  const base = options()
  const root = dirname(base.dataFile)
  const ids = ['local-default', ...Array.from({ length: count }, (_, i) => `inactive-${i}`)]
  for (const id of ids) {
    const input = {
      userDataPath: root,
      profileId: id,
      dataFile: getOrcaProfileDataFile(id, root),
      databaseFile: getOrcaProfileStateDatabaseFile(id, root)
    }
    mkdirSync(dirname(input.dataFile), { recursive: true })
    writeFileSync(input.dataFile, JSON.stringify(buildProfileStateCutoverFixture(root)))
    const state = createProfileStateStore(input).store
    if (id === ids[0]) {
      await state.admitTerminalPane({
        type: 'createTerminalTab',
        workspace: 'repo-local::/fixture/local',
        tabId,
        leafId
      })
      await state.persistPtyBinding({
        worktreeId: 'repo-local::/fixture/local',
        tabId,
        leafId,
        ptyId: '9',
        mayCreate: false
      })
    }
    state.updateSettings({ theme: 'dark' })
    state.flushOrThrow()
    state.freezeWrites()
  }
  writeFileSync(
    getOrcaProfileIndexPath(root),
    JSON.stringify({
      schemaVersion: ORCA_PROFILE_INDEX_SCHEMA_VERSION,
      activeProfileId: ids[0],
      profiles: ids.map((id) => ({
        id,
        name: id,
        avatar: { kind: 'initials', initials: 'P', color: 'neutral' },
        kind: 'local',
        createdAt: 1,
        updatedAt: 1,
        lastOpenedAt: 1
      }))
    })
  )
  const input = {
    userDataPath: root,
    profileId: ids[0],
    dataFile: getOrcaProfileDataFile(ids[0], root),
    databaseFile: getOrcaProfileStateDatabaseFile(ids[0], root)
  }
  return { root, ids, input }
}

export function holdCatalogReply() {
  const gate = deferred<void>()
  const started = deferred<void>()
  const read = ProfileStateWriteWorkerClient.prototype.readTerminalClaims
  let held = false
  vi.spyOn(ProfileStateWriteWorkerClient.prototype, 'readTerminalClaims').mockImplementation(
    async function (this: ProfileStateWriteWorkerClient, request) {
      const result = await read.call(this, request)
      if (!held) {
        held = true
        started.resolve()
        await gate.promise
      }
      return result
    }
  )
  return { gate, started: started.promise }
}

export function readState(input: ReturnType<typeof options>) {
  const reader = new ProfileStateSqliteAuthority(input.databaseFile, input.profileId)
  try {
    return JSON.parse(reader.readSerializedState() ?? '{}')
  } finally {
    reader.close()
  }
}
