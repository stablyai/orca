import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as appEnvironment from '../../../../../shared/app-lifecycle/app-environment'
import { encodePairingOffer } from '../../../../../shared/remote-runtime/pairing/pairing'
import {
  addEnvironmentFromPairingCode,
  removeEnvironment,
  updateEnvironmentFromPairingCode
} from '../../../../../shared/remote-runtime/host-store/runtime-environment-store-operations'
import { getEnvironmentStorePath } from '../../../../../shared/remote-runtime/host-store/runtime-environment-store-records'
import { getRuntimeEnvironmentSidecarPath } from '../../../../../shared/remote-runtime/host-store/runtime-environment-sidecar'
import { useInlineEnvironmentStoreForCli as enableInlineEnvironmentStore } from '../../../../../shared/remote-runtime/host-store/runtime-environment-store-worker-client'
import { createOrchestrationEnvironmentTransport } from '../../../../ipc/runtime-environments/requests/orchestration-environment-transport'
import { OrchestrationDb } from '../../db/orchestration-db'
import { WorkerPlacementCatalogOwner } from './worker-placement-catalog-owner'

enableInlineEnvironmentStore()

let root: string
let db: OrchestrationDb
let owner: WorkerPlacementCatalogOwner
let transport: ReturnType<typeof createOrchestrationEnvironmentTransport>
let environmentId: string
let notify: () => void
const pairing = {
  v: 2 as const,
  endpoint: 'ws://server.example/runtime',
  publicKeyB64: Buffer.alloc(32, 1).toString('base64'),
  deviceToken: 'catalog-token'
}

function open(offline = false): void {
  db = new OrchestrationDb(join(root, 'orchestration.db'))
  transport = createOrchestrationEnvironmentTransport()
  transport.onCatalogChanged = (listener) => {
    notify = listener
    return () => {}
  }
  transport.call = async (_selector, method) => {
    if (offline) {
      throw new Error('offline')
    }
    return {
      id: 'catalog',
      ok: true,
      _meta: { runtimeId: 'peer' },
      result:
        method === 'repo.list'
          ? { repos: [{ id: 'repo', path: '/server/repo', displayName: 'repo' }] }
          : {
              setups: [
                {
                  id: 'setup',
                  projectId: 'github:team/repo',
                  repoId: 'repo',
                  hostId: 'local',
                  path: '/server/repo',
                  displayName: 'repo',
                  setupState: 'ready',
                  workerExecutionTarget: { kind: 'native' }
                }
              ]
            }
    }
  }
  owner = new WorkerPlacementCatalogOwner(db, transport)
}

function rows() {
  return db.db.prepare('SELECT * FROM worker_placement_catalogs').all()
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-11-20T20:00:00Z'))
  root = mkdtempSync(join(tmpdir(), 'orca-placement-registry-'))
  vi.spyOn(appEnvironment, 'getAppEnvironment').mockReturnValue({
    getPath: () => root,
    getAppPath: () => root,
    getVersion: () => 'test',
    isPackaged: () => false,
    onWillQuit: () => {},
    exit: () => {},
    getAppMetrics: () => []
  })
  environmentId = addEnvironmentFromPairingCode(root, {
    name: 'server',
    pairingCode: encodePairingOffer(pairing),
    now: 100
  }).id
  open()
})

afterEach(() => {
  db.close()
  vi.useRealTimers()
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
})

it.each(['record', 'links', 'unidentified record', 'invalid file', 'missing file'])(
  'preserves the exact catalog through unreadable %s, restoration and offline reopen',
  async (failure) => {
    expect(await owner.discover()).toMatchObject([{ status: 'fresh', observedAt: 1795204800000 }])
    const retained = rows()
    expect(retained).toHaveLength(1)
    const storePath = getEnvironmentStorePath(root)
    const saved = readFileSync(storePath, 'utf8')
    const file = JSON.parse(saved)
    if (failure === 'links') {
      writeFileSync(
        getRuntimeEnvironmentSidecarPath(root),
        JSON.stringify({ version: 1, entries: { [environmentId]: { binding: 'unreadable' } } })
      )
    } else if (failure === 'record') {
      file.environments[0].kind = 'future-pairing'
      writeFileSync(storePath, JSON.stringify(file))
    } else if (failure === 'unidentified record') {
      file.environments = ['opaque future record']
      writeFileSync(storePath, JSON.stringify(file))
    } else if (failure === 'invalid file') {
      writeFileSync(storePath, '{')
    } else {
      rmSync(storePath)
    }
    notify()
    if (failure === 'invalid file') {
      await expect(owner.discover()).rejects.toMatchObject({ code: 'runtime_error' })
    } else {
      expect(await owner.discover()).toEqual([])
    }
    // Let the saved-registry read queued by reconciliation finish before restoring the file.
    await setImmediate()
    expect(rows()).toEqual(retained)
    writeFileSync(storePath, saved)
    rmSync(getRuntimeEnvironmentSidecarPath(root), { force: true })
    notify()
    expect(await owner.discover()).toMatchObject([{ status: 'fresh', observedAt: 1795204800000 }])
    expect(rows()).toEqual(retained)
    db.close()
    vi.setSystemTime(Date.now() + 30_001)
    open(true)
    expect(await owner.discover()).toMatchObject([
      {
        status: 'retained',
        observedAt: 1795204800000,
        catalog: { setups: [{ id: 'setup', workerExecutionTarget: { kind: 'native' } }] }
      }
    ])
    expect(rows()).toEqual(retained)
  }
)

it.each(['removed', 're-paired'])(
  'deletes the persisted catalog when the saved pairing is genuinely %s',
  async (change) => {
    await owner.discover()
    expect(rows()).toHaveLength(1)
    if (change === 'removed') {
      removeEnvironment(root, environmentId)
    } else {
      updateEnvironmentFromPairingCode(root, environmentId, {
        pairingCode: encodePairingOffer({ ...pairing, deviceToken: 'replacement-token' }),
        now: 200
      })
    }
    notify()
    await vi.waitFor(() => expect(rows()).toEqual([]))
    db.close()
    open(true)
    expect(await owner.discover(environmentId)).toMatchObject([
      { status: 'unchecked', reason: 'no_answer' }
    ])
    expect(rows()).toEqual([])
  }
)

it('discards an early catalog when its pairing changes before the other results return', async () => {
  await owner.discover()
  const slow = addEnvironmentFromPairingCode(root, {
    name: 'slow',
    pairingCode: encodePairingOffer({
      ...pairing,
      endpoint: 'ws://slow.example/runtime',
      publicKeyB64: Buffer.alloc(32, 2).toString('base64')
    }),
    now: 200
  })
  const slowStarted = Promise.withResolvers<void>()
  const slowReply = Promise.withResolvers<void>()
  const call = transport.call
  transport.call = async (...args) => {
    if (args[0] === slow.id) {
      slowStarted.resolve()
      await slowReply.promise
    }
    return call(...args)
  }
  const discovery = owner.discover()
  await slowStarted.promise
  await setImmediate()
  updateEnvironmentFromPairingCode(root, environmentId, {
    pairingCode: encodePairingOffer({ ...pairing, deviceToken: 'replacement-token' }),
    now: 300
  })
  notify()
  slowReply.resolve()
  const snapshots = await discovery
  expect(
    snapshots.find((snapshot) => snapshot.server.environmentId === environmentId)
  ).toMatchObject({
    status: 'unchecked',
    reason: 'no_answer'
  })
  expect(snapshots.find((snapshot) => snapshot.server.environmentId === slow.id)).toMatchObject({
    status: 'fresh'
  })
})
