import { build } from 'esbuild'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, vi } from 'vitest'
import { buildProfileStateCutoverFixture } from '../../profile-state-cutover-fixture'
import { ProfileStateSqliteAuthority } from '../../profile-state/profile-state-sqlite-authority'
import { ProfileStateWorkerAuthority } from '../../profile-state/profile-state-worker-authority'
import { Store } from '../store'

// A Store backed by the real profile-state writer worker, so tests exercise its actual async SQLite transactions.
let bundleRoot: string
let workerOptions: { workerPath: string; backupWorkerPath: string }
const stores: Store[] = []
const roots: string[] = []
const releases: (() => void)[] = []

beforeAll(async () => {
  bundleRoot = mkdtempSync(join(tmpdir(), 'orca-lineage-uncertainty-worker-'))
  workerOptions = {
    workerPath: join(bundleRoot, 'profile-state-writer-worker-entry.js'),
    backupWorkerPath: join(bundleRoot, 'profile-state-backup-worker-entry.js')
  }
  await build({
    entryPoints: [
      resolve('src/main/persistence/profile-state/writer/profile-state-writer-worker-entry.ts'),
      resolve('src/main/persistence/profile-state/backup/profile-state-backup-worker-entry.ts')
    ],
    entryNames: '[name]',
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
})
afterAll(() => rmSync(bundleRoot, { recursive: true, force: true }))

export function writerBarrier() {
  const gate = Promise.withResolvers<void>()
  releases.push(gate.resolve)
  return gate
}

/** A writer worker that, once `arm()` is called, commits the next write and then exits before its
 *  reply reaches the Store: the acknowledgement is genuinely lost at the process boundary. */
export function lostAcknowledgementWorker(directory: string) {
  const armFile = join(directory, 'lose-next-acknowledgement')
  const workerPath = join(directory, 'lost-ack-writer-worker.cjs')
  writeFileSync(
    workerPath,
    `
    const { existsSync, rmSync } = require('node:fs')
    const { MessagePort } = require('node:worker_threads')
    const send = MessagePort.prototype.postMessage
    MessagePort.prototype.postMessage = function (value, ...rest) {
      if (value && value.ok && existsSync(${JSON.stringify(armFile)})) {
        rmSync(${JSON.stringify(armFile)})
        process.exit(13)
      }
      return send.call(this, value, ...rest)
    }
    require(${JSON.stringify(workerOptions.workerPath)})
    `
  )
  return {
    workerPath,
    arm: () => writeFileSync(armFile, ''),
    armed: () => existsSync(armFile)
  }
}

export async function createWorkerBackedStore(
  options: { worker?: (directory: string) => { workerPath: string } } = {}
) {
  const directory = mkdtempSync(join(tmpdir(), 'orca-lineage-uncertainty-profile-'))
  roots.push(directory)
  const databaseFile = join(directory, 'profile-state.db')
  const profileId = 'lineage-uncertainty-test'
  const bootstrap = new ProfileStateSqliteAuthority(databaseFile, profileId)
  bootstrap.writeSerializedState(
    Buffer.from(JSON.stringify(buildProfileStateCutoverFixture(directory)))
  )
  const state = bootstrap.readInitialState().takeParsedState?.()
  const worker = options.worker?.(directory)
  const authority = new ProfileStateWorkerAuthority(bootstrap.retireForWorker(), {
    ...workerOptions,
    ...(worker ? { workerPath: worker.workerPath } : {})
  })
  await authority.ready
  const store = new Store({
    dataFile: join(directory, 'orca-data.json'),
    profileStateAuthority: authority,
    initialAuthorityState: { authority, takeParsedState: () => state }
  })
  stores.push(store)
  const backup = vi.spyOn(authority, 'scheduleBackup').mockImplementation(() => {})
  await store.flushPendingOrThrowAsync()
  backup.mockRestore()
  const readState = () => {
    const reader = new ProfileStateSqliteAuthority(databaseFile, profileId)
    try {
      return JSON.parse(reader.readSerializedState() ?? '{}')
    } finally {
      reader.close()
    }
  }
  return { directory, databaseFile, store, authority, readState }
}
