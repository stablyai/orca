import '../../../../shared/remote-runtime/host-store/environment-store-worker.test-support'
import { resetRuntimeEnvironmentStatusOwners } from '../connections/runtime-environment-request-connections'
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }))
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createSharedControlTestServer,
  closeSharedControlTestServers
} from '../../../../shared/remote-runtime/control/remote-runtime-shared-control-test-server'
import type { sendRemoteRuntimeRequestOnSocket } from '../../../../shared/remote-runtime/requests/remote-runtime-request-socket'
import { encodePairingOffer } from '../../../../shared/remote-runtime/pairing/pairing'
import {
  addEnvironmentFromPairingCode,
  markEnvironmentUsed
} from '../../../../shared/remote-runtime/host-store/runtime-environment-store'

const { sendRemoteRuntimeRequestOnSocketMock, sendRemoteRuntimeSharedControlRequestMock } =
  vi.hoisted(() => ({
    sendRemoteRuntimeRequestOnSocketMock: vi.fn(),
    sendRemoteRuntimeSharedControlRequestMock: vi.fn()
  }))

vi.mock('../../../../shared/remote-runtime/requests/remote-runtime-request-socket', () => ({
  sendRemoteRuntimeRequestOnSocket: sendRemoteRuntimeRequestOnSocketMock
}))

vi.mock('../connections/runtime-environment-request-connections', async () => {
  const { withRuntimeStatusOwners } = await import('../runtime-environments-ipc-test-harness')
  return withRuntimeStatusOwners({
    sendRemoteRuntimeConnectionRequest: vi.fn(),
    sendRemoteRuntimeSharedControlRequest: sendRemoteRuntimeSharedControlRequestMock,
    reconnectRemoteRuntimeSharedControlConnection: vi.fn(),
    ensureRemoteRuntimeSharedControlConnection: vi.fn(),
    pauseRemoteRuntimeSharedControlRetry: vi.fn()
  })
})

import { callRuntimeEnvironment } from './runtime-environment-transport-routing'
import { resetSharedControlSupport } from '../connections/runtime-environment-shared-control-support'

const actual = await vi.importActual<{
  sendRemoteRuntimeRequestOnSocket: typeof sendRemoteRuntimeRequestOnSocket
}>('../../../../shared/remote-runtime/requests/remote-runtime-request-socket')

describe('federated read RPC transport routing', () => {
  let userDataPath: string

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-federated-read-routing-'))
    resetSharedControlSupport()
    sendRemoteRuntimeRequestOnSocketMock.mockReset()
    sendRemoteRuntimeSharedControlRequestMock.mockReset()
  })

  afterEach(async () => {
    await closeSharedControlTestServers()
    resetRuntimeEnvironmentStatusOwners()
    rmSync(userDataPath, { recursive: true, force: true })
  })

  it('refuses a runtime-pinned one-shot mutation when its socket reaches a restarted host', async () => {
    const server = await createSharedControlTestServer({
      resultForRequest: (method) =>
        method === 'status.get' ? { runtimeId: 'runtime-restarted', capabilities: [] } : {}
    })
    const paired = await addEnvironmentFromPairingCode(userDataPath, {
      name: 'Restarted host',
      pairingCode: encodePairingOffer(server.offer)
    })
    await markEnvironmentUsed(userDataPath, paired.id, { runtimeId: 'runtime-proven' })
    sendRemoteRuntimeRequestOnSocketMock.mockImplementation(actual.sendRemoteRuntimeRequestOnSocket)
    await expect(
      callRuntimeEnvironment(
        userDataPath,
        paired.id,
        'orchestration.federationRelease',
        { dispatchId: 'dispatch-1' },
        15_000,
        undefined,
        { orchestrationContractVersion: 1, orchestrationRequestId: 'release-1' },
        { expectedEnvironmentRuntimeId: 'runtime-proven' }
      )
    ).resolves.toMatchObject({ ok: false, error: { code: 'runtime_environment_changed' } })
    expect(
      server.requests.filter((request) => request.method === 'orchestration.federationRelease')
    ).toEqual([])
  })
})
