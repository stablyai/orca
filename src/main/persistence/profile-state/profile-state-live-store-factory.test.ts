import { build } from 'esbuild'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Store } from '../loading-store/store'
import { ProfileStateSqliteAuthority } from './profile-state-sqlite-authority'
import { createLiveProfileStateStore } from './profile-state-live-store-factory'
import type { ProfileStateStoreFactoryOptions } from './profile-state-store-factory'
import {
  profileStateJsonExportPath,
  profileStateJsonExportPaths
} from './legacy-json/profile-state-export-path'

vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))
vi.mock('../../ssh/config/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

let bundleRoot: string
let workerOptions: { workerPath: string; backupWorkerPath: string }
const roots: string[] = []
const stores: Store[] = []

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

function options() {
  const root = mkdtempSync(join(tmpdir(), 'orca-live-profile-'))
  roots.push(root)
  return {
    dataFile: join(root, 'orca-data.json'),
    databaseFile: join(root, 'profile-state.db'),
    profileId: 'live-profile-test'
  }
}

async function open(input: ProfileStateStoreFactoryOptions) {
  const result = await createLiveProfileStateStore(input, workerOptions)
  stores.push(result.store)
  return result
}

function readState(input: ReturnType<typeof options>) {
  const reader = new ProfileStateSqliteAuthority(input.databaseFile, input.profileId)
  try {
    return JSON.parse(reader.readSerializedState() ?? '{}')
  } finally {
    reader.close()
  }
}

describe('live profile authority admission', () => {
  it('never adopts a competing revision between bootstrap and worker readiness', async () => {
    const input = options()
    const original = ProfileStateSqliteAuthority.prototype.retireForWorker
    vi.spyOn(ProfileStateSqliteAuthority.prototype, 'retireForWorker').mockImplementation(function (
      this: ProfileStateSqliteAuthority
    ) {
      const handoff = original.call(this)
      const peer = new ProfileStateSqliteAuthority(input.databaseFile, input.profileId)
      try {
        peer.readSerializedState()
        peer.writeSerializedDomains([{ domain: 'peer', payload: '{"retained":true}' }])
      } finally {
        peer.close()
      }
      return handoff
    })
    await expect(open(input)).rejects.toThrow('Profile state revision changed')
    expect(readState(input).peer).toEqual({ retained: true })
  })

  it('orders exports with full checkpoints and closes backup and writer handles on final flush', async () => {
    const input = options()
    const { store } = await open(input)
    store.getWorkspaceSession().activeTabId = 'getter-export'
    store.updateSettings({ theme: 'dark' })
    const revision = await store.writeLatestProfileStateJsonExportAsync()
    expect(revision).toBeTypeOf('number')
    if (revision === undefined) {
      throw new Error('Expected a persisted profile revision')
    }
    expect(
      JSON.parse(readFileSync(profileStateJsonExportPath(input.dataFile, revision), 'utf8'))
        .workspaceSession.activeTabId
    ).toBe('getter-export')
    const retainedExports = profileStateJsonExportPaths(input.dataFile)
    store.updateSettings({ theme: 'light' })
    await store.flushFinalOrThrowAsync()
    expect(existsSync(input.dataFile)).toBe(false)
    expect(profileStateJsonExportPaths(input.dataFile)).toEqual(retainedExports)
    expect(profileStateJsonExportPaths(input.dataFile).length).toBeGreaterThan(0)
    expect(readState(input).settings.theme).toBe('light')
    await expect(store.flushPendingOrThrowAsync()).rejects.toThrow('finalized')
    const reopened = await open(input)
    expect(reopened.store.getSettings().theme).toBe('light')
  })
})
