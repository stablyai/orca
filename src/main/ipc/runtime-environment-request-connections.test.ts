import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { encodePairingOffer, type PairingOffer } from '../../shared/pairing'
import {
  addEnvironmentFromPairingCode,
  removeEnvironment
} from '../../shared/runtime-environment-store'
import {
  closeSharedControlTestServers,
  createSharedControlTestServer
} from '../../shared/remote-runtime-shared-control-test-server'
import { setRuntimeEnvironmentRemovalWatch } from './runtime-environment-removal-watch'
import {
  applyRuntimeEnvironmentCapabilityVerdict,
  captureRuntimeEnvironmentCapabilityEvidence,
  resetRuntimeEnvironmentCapabilityEvidence
} from './runtime-environment-capability-evidence'
import {
  clearRuntimeEnvironmentManualDisconnect,
  markRuntimeEnvironmentManuallyDisconnected
} from './runtime-environment-manual-disconnect'
import {
  closeRemoteRuntimeRequestConnection,
  ensureRemoteRuntimeSharedControlConnection,
  getRemoteRuntimeSharedControlDiagnostics,
  pauseRemoteRuntimeSharedControlRetry,
  reconnectRemoteRuntimeSharedControlConnection,
  sendRemoteRuntimeSharedControlRequest,
  subscribeRemoteRuntimeSharedControlRequest
} from './runtime-environment-request-connections'

const ENVIRONMENT_ID = 'standing-intent-test'
const tempUserDataPaths: string[] = []

function storeEnvironment(pairing: PairingOffer): { userDataPath: string; environmentId: string } {
  const userDataPath = mkdtempSync(join(tmpdir(), 'orca-request-connections-'))
  tempUserDataPaths.push(userDataPath)
  const environment = addEnvironmentFromPairingCode(userDataPath, {
    name: 'desk',
    pairingCode: encodePairingOffer(pairing)
  })
  return { userDataPath, environmentId: environment.id }
}

afterEach(async () => {
  closeRemoteRuntimeRequestConnection(ENVIRONMENT_ID)
  clearRuntimeEnvironmentManualDisconnect(ENVIRONMENT_ID)
  resetRuntimeEnvironmentCapabilityEvidence()
  setRuntimeEnvironmentRemovalWatch(null)
  for (const dir of tempUserDataPaths.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
  await closeSharedControlTestServers()
})

describe('runtime environment shared-control connection cache', () => {
  it('ensures once and resumes a paused standing connection from capable evidence', async () => {
    const server = await createSharedControlTestServer()
    ensureRemoteRuntimeSharedControlConnection(ENVIRONMENT_ID, server.pairing)
    ensureRemoteRuntimeSharedControlConnection(ENVIRONMENT_ID, server.pairing)
    reconnectRemoteRuntimeSharedControlConnection(ENVIRONMENT_ID)
    await waitFor(() => server.connectionCount() === 1)

    server.closeClients()
    await waitFor(
      () => getRemoteRuntimeSharedControlDiagnostics(ENVIRONMENT_ID)?.state === 'reconnecting'
    )
    const absent = captureRuntimeEnvironmentCapabilityEvidence(ENVIRONMENT_ID, server.pairing)
    applyRuntimeEnvironmentCapabilityVerdict({
      evidence: absent,
      verdict: 'absent',
      runtimeId: 'runtime-test'
    })
    pauseRemoteRuntimeSharedControlRetry(ENVIRONMENT_ID)
    expect(getRemoteRuntimeSharedControlDiagnostics(ENVIRONMENT_ID)?.state).toBe('closed')
    await delay(400)
    expect(server.connectionCount()).toBe(1)

    const capable = captureRuntimeEnvironmentCapabilityEvidence(ENVIRONMENT_ID, server.pairing)
    applyRuntimeEnvironmentCapabilityVerdict({
      evidence: capable,
      verdict: 'capable',
      runtimeId: 'runtime-test'
    })
    ensureRemoteRuntimeSharedControlConnection(ENVIRONMENT_ID, server.pairing)
    reconnectRemoteRuntimeSharedControlConnection(ENVIRONMENT_ID)
    await waitFor(() => server.connectionCount() === 2)
  })

  it('blocks standing creation while manual intent is disconnected', async () => {
    const server = await createSharedControlTestServer()
    markRuntimeEnvironmentManuallyDisconnected(ENVIRONMENT_ID)

    ensureRemoteRuntimeSharedControlConnection(ENVIRONMENT_ID, server.pairing)
    reconnectRemoteRuntimeSharedControlConnection(ENVIRONMENT_ID)
    await delay(50)

    expect(server.connectionCount()).toBe(0)
    expect(getRemoteRuntimeSharedControlDiagnostics(ENVIRONMENT_ID)).toBeNull()
  })

  it('never retries a connection whose environment the CLI removed from the store', async () => {
    const server = await createSharedControlTestServer()
    const { userDataPath, environmentId } = storeEnvironment(server.pairing)
    setRuntimeEnvironmentRemovalWatch({
      getUserDataPath: () => userDataPath,
      retire: async (id) => closeRemoteRuntimeRequestConnection(id)
    })
    ensureRemoteRuntimeSharedControlConnection(environmentId, server.pairing)
    reconnectRemoteRuntimeSharedControlConnection(environmentId)
    await waitFor(() => server.connectionCount() === 1)

    removeEnvironment(userDataPath, environmentId)
    server.closeClients()
    // Why the cache entry disappears rather than settling on 'closed': the close observes the
    // removal and retires the transport, which is what leaves nothing behind to retry.
    await waitFor(() => getRemoteRuntimeSharedControlDiagnostics(environmentId) === null)
    await delay(400)

    expect(server.connectionCount()).toBe(1)
    closeRemoteRuntimeRequestConnection(environmentId)
  })

  it('lets a bypass request finish but never retries it after manual disconnect', async () => {
    const server = await createSharedControlTestServer()
    markRuntimeEnvironmentManuallyDisconnected(ENVIRONMENT_ID)
    await sendRemoteRuntimeSharedControlRequest(
      ENVIRONMENT_ID,
      server.pairing,
      'repo.list',
      undefined,
      1_000
    )

    server.closeClients()
    await waitFor(
      () => getRemoteRuntimeSharedControlDiagnostics(ENVIRONMENT_ID)?.state === 'closed'
    )
    await delay(400)

    expect(server.connectionCount()).toBe(1)
    expect(getRemoteRuntimeSharedControlDiagnostics(ENVIRONMENT_ID)?.state).toBe('closed')
  })

  it('leaves a subscription-holding connection untouched by an absent verdict', async () => {
    const server = await createSharedControlTestServer()
    const subscription = await subscribeRemoteRuntimeSharedControlRequest(
      ENVIRONMENT_ID,
      server.pairing,
      'session.tabs.subscribeAll',
      undefined,
      1_000,
      { onResponse: vi.fn(), onError: vi.fn(), onClose: vi.fn() }
    )
    server.closeClients()
    await waitFor(
      () => getRemoteRuntimeSharedControlDiagnostics(ENVIRONMENT_ID)?.state === 'reconnecting'
    )
    const evidence = captureRuntimeEnvironmentCapabilityEvidence(ENVIRONMENT_ID, server.pairing)

    applyRuntimeEnvironmentCapabilityVerdict({
      evidence,
      verdict: 'absent',
      runtimeId: 'runtime-test'
    })
    pauseRemoteRuntimeSharedControlRetry(ENVIRONMENT_ID)

    expect(getRemoteRuntimeSharedControlDiagnostics(ENVIRONMENT_ID)?.state).toBe('reconnecting')
    await waitFor(() => server.connectionCount() === 2)
    subscription.close()
  })
})

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const startedAt = Date.now()
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('Timed out waiting for cached shared-control connection')
    }
    await delay(10)
  }
}

const delay = (timeoutMs: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, timeoutMs))
