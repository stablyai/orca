import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RemoteRuntimeSharedControlConnection } from '../../../shared/remote-runtime/control/remote-runtime-shared-control-connection'
import {
  closeSharedControlTestServers,
  createSharedControlTestServer,
  type SharedControlTestServer
} from '../../../shared/remote-runtime/control/remote-runtime-shared-control-test-server'
import { getPreferredPairedRuntimeConnection } from '../../../shared/remote-runtime/host-catalog/runtime-environments'
import {
  addEnvironmentFromPairingCode,
  removeEnvironment
} from '../../../shared/remote-runtime/host-store/runtime-environment-store'
import { getEnvironmentStorePath } from '../../../shared/remote-runtime/host-store/runtime-environment-store-records'
import { encodePairingOffer } from '../../../shared/remote-runtime/pairing/pairing'
import {
  closeRemoteRuntimeRequestConnection,
  getRemoteRuntimeSharedControlDiagnostics,
  listCachedRuntimeEnvironmentIds,
  sendRemoteRuntimeSharedControlRequest
} from './runtime-environment-request-connections'
import {
  createRemovedRuntimeEnvironmentSweep,
  watchRemovedRuntimeEnvironmentConnections
} from './runtime-environment-removed-connections'

const PAST_LONGEST_IDLE_BACKOFF_MS = 10 * 60_000

const registries: string[] = []
let userDataPath: string

beforeEach(() => {
  userDataPath = createRegistry()
})

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  for (const environmentId of listCachedRuntimeEnvironmentIds()) {
    closeRemoteRuntimeRequestConnection(environmentId)
  }
  await closeSharedControlTestServers()
  for (const registry of registries.splice(0)) {
    rmSync(registry, { recursive: true, force: true })
  }
})

describe('transports of a server removed from the registry', () => {
  it('closes a reconnecting socket after `orca environment rm` and never redials', async () => {
    const server = await createSharedControlTestServer()
    const environmentId = await connect(server, 'pool')
    const sweep = createRemovedRuntimeEnvironmentSweep(userDataPath)
    const state = () => getRemoteRuntimeSharedControlDiagnostics(environmentId)?.state
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    server.closeClients()
    await vi.waitFor(() => expect(state()).toBe('reconnecting'), { interval: 1 })

    const close = vi.spyOn(RemoteRuntimeSharedControlConnection.prototype, 'close')

    removeEnvironment(userDataPath, environmentId)
    sweep()

    expect(getRemoteRuntimeSharedControlDiagnostics(environmentId)).toBeNull()
    expect(listCachedRuntimeEnvironmentIds()).toEqual([])
    const [closed] = close.mock.contexts as RemoteRuntimeSharedControlConnection[]
    expect(closed?.getDiagnostics().state).toBe('closed')
    await vi.advanceTimersByTimeAsync(PAST_LONGEST_IDLE_BACKOFF_MS)
    expect(server.connectionCount()).toBe(1)
  })

  it('closes once the registry watch sees a removal written by another process', async () => {
    const server = await createSharedControlTestServer()
    const environmentId = await connect(server, 'pool')
    const stopWatching = watchRemovedRuntimeEnvironmentConnections(userDataPath)
    try {
      removeEnvironment(userDataPath, environmentId)

      await vi.waitFor(
        () => expect(getRemoteRuntimeSharedControlDiagnostics(environmentId)).toBeNull(),
        { timeout: 5_000 }
      )
    } finally {
      stopWatching()
    }
  })

  it('keeps saved servers, servers of another registry, and all while unreadable', async () => {
    const removedId = await connect(await createSharedControlTestServer(), 'removed')
    const savedId = await connect(await createSharedControlTestServer(), 'saved')
    const otherRegistry = createRegistry()
    const otherId = await connect(await createSharedControlTestServer(), 'other', otherRegistry)
    const sweep = createRemovedRuntimeEnvironmentSweep(userDataPath)

    removeEnvironment(userDataPath, removedId)
    const storePath = getEnvironmentStorePath(userDataPath)
    const afterRemoval = readFileSync(storePath)
    writeFileSync(storePath, '{not json')
    sweep()
    expect(getRemoteRuntimeSharedControlDiagnostics(removedId)?.state).toBe('ready')

    writeFileSync(storePath, afterRemoval)
    sweep()

    expect(getRemoteRuntimeSharedControlDiagnostics(removedId)).toBeNull()
    expect(getRemoteRuntimeSharedControlDiagnostics(savedId)?.state).toBe('ready')
    expect(getRemoteRuntimeSharedControlDiagnostics(otherId)?.state).toBe('ready')
  })

  it('connects again when the removed server is paired and used again', async () => {
    const server = await createSharedControlTestServer()
    const removedId = await connect(server, 'pool')
    const sweep = createRemovedRuntimeEnvironmentSweep(userDataPath)
    removeEnvironment(userDataPath, removedId)
    sweep()

    const repairedId = await connect(server, 'pool')
    sweep()

    expect(repairedId).not.toBe(removedId)
    expect(getRemoteRuntimeSharedControlDiagnostics(removedId)).toBeNull()
    expect(getRemoteRuntimeSharedControlDiagnostics(repairedId)?.state).toBe('ready')
    expect(server.connectionCount()).toBe(2)
  })
})

function createRegistry(): string {
  const registry = mkdtempSync(join(tmpdir(), 'orca-removed-connections-'))
  registries.push(registry)
  return registry
}

async function connect(
  server: SharedControlTestServer,
  name: string,
  registry = userDataPath
): Promise<string> {
  const environment = addEnvironmentFromPairingCode(registry, {
    name,
    pairingCode: encodePairingOffer(server.offer)
  })
  const response = await sendRemoteRuntimeSharedControlRequest(
    environment.id,
    getPreferredPairedRuntimeConnection(environment),
    'status.get',
    undefined,
    1_000
  )
  expect(response.ok).toBe(true)
  return environment.id
}
