import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import { encodePairingOffer } from '../../shared/pairing'
import {
  addEnvironmentFromPairingCode,
  getEnvironmentStorePath,
  removeEnvironment
} from '../../shared/runtime-environment-store'
import { toRuntimeExecutionHostId } from '../../shared/execution-host'
import { createSqliteTestStore } from '../persistence-test-harness'
import { Store } from '../persistence/loading-store/store'
import { reconcileOrphanedRuntimeSessions } from './runtime-environment-session-reconcile'

vi.mock('electron', () => ({
  app: { getPath: () => tmpdir(), getName: () => 'orca-test', getVersion: () => '0.0.0', on() {} },
  safeStorage: { isEncryptionAvailable: () => false },
  BrowserWindow: { getAllWindows: () => [] }
}))
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup()
  }
})
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'orca-historical-sessions-'))
  const store = createSqliteTestStore(Store, { dataFile: join(dir, 'profile', 'orca-data.json') })
  cleanups.push(async () => {
    await store.freezeWritesAsync()
    rmSync(dir, { recursive: true, force: true })
  })
  const pair = (name: string) =>
    addEnvironmentFromPairingCode(dir, {
      name,
      pairingCode: encodePairingOffer({
        v: 2,
        endpoint: 'ws://192.0.2.10:6768',
        deviceToken: 'test',
        publicKeyB64: Buffer.alloc(32, 1).toString('base64')
      })
    })
  const gone = pair('gone')
  const kept = pair('kept')
  removeEnvironment(dir, gone.id)
  const hostId = toRuntimeExecutionHostId(gone.id)
  store.setWorkspaceSession(
    { ...getDefaultWorkspaceSession(), activeWorktreeId: 'historical' },
    hostId
  )
  return { dir, store, hostId, kept }
}

it('archives a historical removed paired host while preserving local, SSH and legacy namespaces', async () => {
  const { dir, store, hostId, kept } = fixture()
  const survivors = [
    'local',
    'ssh:direct',
    'runtime:legacy-namespace',
    toRuntimeExecutionHostId(kept.id)
  ]
  for (const owner of survivors) {
    store.setWorkspaceSession(getDefaultWorkspaceSession(), owner)
  }
  await reconcileOrphanedRuntimeSessions({ store, userDataPath: dir })
  expect(store.getWorkspaceSessionHostIds()).not.toContain(hostId)
  expect(store.isRuntimeWorkspaceSessionRetired(hostId)).toBe(true)
  expect(store.getWorkspaceSessionHostIds()).toEqual(expect.arrayContaining(survivors))
})

it.each(['missing', 'corrupt', 'unsupported', 'empty'] as const)(
  'preserves historical partitions when the registry is %s',
  async (kind) => {
    const { dir, store, hostId } = fixture()
    const file = getEnvironmentStorePath(dir)
    if (kind === 'missing') {
      rmSync(file)
    }
    if (kind === 'corrupt') {
      writeFileSync(file, '{broken')
    }
    if (kind === 'unsupported') {
      writeFileSync(file, '{"version":999,"environments":[]}')
    }
    if (kind === 'empty') {
      writeFileSync(file, '{"version":1,"environments":[]}')
    }
    await reconcileOrphanedRuntimeSessions({ store, userDataPath: dir })
    expect(store.getWorkspaceSessionHostIds()).toContain(hostId)
    expect(store.isRuntimeWorkspaceSessionRetired(hostId)).toBe(false)
  }
)

it('preserves a paired-looking namespace that the current main catalog owns', async () => {
  const { dir, store, hostId } = fixture()
  store.addRepo({
    id: 'custody',
    path: '/custody',
    displayName: 'Custody',
    badgeColor: 'gray',
    addedAt: 1,
    executionHostId: hostId
  })
  await reconcileOrphanedRuntimeSessions({ store, userDataPath: dir })
  expect(store.getWorkspaceSessionHostIds()).toContain(hostId)
})
