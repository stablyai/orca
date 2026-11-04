import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, vi } from 'vitest'
import { closeTestJournalHostDatabases } from '../../native-chat/agent-session-journal/journal-host-database-test-support'
import type { Store } from '../loading-store/store'
import { ProfileStateSqliteAuthority } from './profile-state-sqlite-authority'
import { createLiveProfileStateStore } from './profile-state-live-store-factory'

export let bundleRoot: string
export let workerOptions: { workerPath: string; backupWorkerPath: string }
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
  await closeTestJournalHostDatabases()
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

export async function open(input: ReturnType<typeof options>) {
  const result = await createLiveProfileStateStore(input, workerOptions)
  stores.push(result.store)
  return result
}

export function readState(input: ReturnType<typeof options>) {
  const reader = new ProfileStateSqliteAuthority(input.databaseFile, input.profileId)
  try {
    return JSON.parse(reader.readSerializedState() ?? '{}')
  } finally {
    reader.close()
  }
}
