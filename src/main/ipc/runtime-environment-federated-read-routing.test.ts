import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encodePairingOffer } from '../../shared/pairing'
import {
  ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES,
  REMOTE_RUNTIME_SHARED_CONTROL_CAPABILITY
} from '../../shared/protocol-version'
import { addEnvironmentFromPairingCode } from '../../shared/runtime-environment-store'

const { sendRemoteRuntimeRequestMock, sendRemoteRuntimeSharedControlRequestMock } = vi.hoisted(
  () => ({
    sendRemoteRuntimeRequestMock: vi.fn(),
    sendRemoteRuntimeSharedControlRequestMock: vi.fn()
  })
)

vi.mock('../../shared/remote-runtime-client', () => ({
  sendRemoteRuntimeRequest: sendRemoteRuntimeRequestMock
}))

vi.mock('./runtime-environment-request-connections', () => ({
  sendRemoteRuntimeConnectionRequest: vi.fn(),
  sendRemoteRuntimeSharedControlRequest: sendRemoteRuntimeSharedControlRequestMock,
  reconnectRemoteRuntimeSharedControlConnection: vi.fn()
}))

import {
  callRuntimeEnvironment,
  resetSharedControlSupport
} from './runtime-environment-transport-routing'

describe('federated read RPC transport routing', () => {
  let userDataPath: string
  let environmentId: string

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-federated-read-routing-'))
    environmentId = addEnvironmentFromPairingCode(userDataPath, {
      name: 'worker',
      pairingCode: encodePairingOffer({
        v: 2,
        endpoint: 'ws://127.0.0.1:6768',
        deviceToken: 'device-token',
        publicKeyB64: Buffer.from(new Uint8Array(32).fill(1)).toString('base64')
      })
    }).id
    resetSharedControlSupport()
    sendRemoteRuntimeRequestMock.mockReset()
    sendRemoteRuntimeSharedControlRequestMock.mockReset()
  })

  afterEach(() => {
    rmSync(userDataPath, { recursive: true, force: true })
  })

  it('routes an enveloped federation read over shared control with its authority intact', async () => {
    const envelope = {
      orchestrationCapability: 'capability',
      orchestrationContractVersion: 1,
      orchestrationRequestId: 'request-1',
      compatibilityInvocationId: 'compatibility-1',
      orchestrationCompatibilityEvidence: {
        terminalHandle: 'term-1',
        paneKey: 'pane-1',
        launchToken: 'launch-1'
      }
    }
    sendRemoteRuntimeRequestMock.mockResolvedValue({
      id: 'status',
      ok: true,
      result: { capabilities: [REMOTE_RUNTIME_SHARED_CONTROL_CAPABILITY] },
      _meta: { runtimeId: 'runtime-worker' }
    })
    sendRemoteRuntimeSharedControlRequestMock.mockResolvedValue({
      id: 'pull',
      ok: true,
      result: { runtimeEpoch: 'runtime-worker', items: [] },
      _meta: { runtimeId: 'runtime-worker' }
    })

    await expect(
      callRuntimeEnvironment(
        userDataPath,
        environmentId,
        'orchestration.federationPull',
        { dispatchId: 'dispatch-1', afterSequence: 0, limit: 50 },
        15_000,
        undefined,
        envelope
      )
    ).resolves.toMatchObject({ ok: true })

    expect(sendRemoteRuntimeRequestMock.mock.calls.map((call) => call[1])).toEqual(['status.get'])
    expect(sendRemoteRuntimeSharedControlRequestMock).toHaveBeenCalledWith(
      environmentId,
      expect.any(Object),
      'orchestration.federationPull',
      { dispatchId: 'dispatch-1', afterSequence: 0, limit: 50 },
      15_000,
      envelope
    )
  })

  it('keeps enveloped federation mutations on the one-shot transport', async () => {
    const envelope = { orchestrationContractVersion: 1, orchestrationRequestId: 'ack-1' }
    sendRemoteRuntimeRequestMock.mockResolvedValue({
      id: 'ack',
      ok: true,
      result: { acknowledgedThrough: 4 },
      _meta: { runtimeId: 'runtime-worker' }
    })

    await callRuntimeEnvironment(
      userDataPath,
      environmentId,
      'orchestration.federationAck',
      { dispatchId: 'dispatch-1', throughSequence: 4 },
      15_000,
      undefined,
      envelope
    )

    expect(sendRemoteRuntimeRequestMock).toHaveBeenCalledWith(
      expect.any(Object),
      'orchestration.federationAck',
      { dispatchId: 'dispatch-1', throughSequence: 4 },
      15_000,
      envelope,
      undefined,
      ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES
    )
    expect(sendRemoteRuntimeSharedControlRequestMock).not.toHaveBeenCalled()
  })

  it('falls back to one-shot with the envelope when shared control is unavailable', async () => {
    const envelope = { orchestrationContractVersion: 1 }
    sendRemoteRuntimeRequestMock.mockImplementation(async (_pairing, method) =>
      method === 'status.get'
        ? {
            id: 'status',
            ok: true,
            result: { capabilities: [] },
            _meta: { runtimeId: 'runtime-worker' }
          }
        : {
            id: 'pull',
            ok: true,
            result: { runtimeEpoch: 'runtime-worker', items: [] },
            _meta: { runtimeId: 'runtime-worker' }
          }
    )

    await callRuntimeEnvironment(
      userDataPath,
      environmentId,
      'orchestration.federationPull',
      { dispatchId: 'dispatch-1', afterSequence: 0, limit: 50 },
      15_000,
      undefined,
      envelope
    )

    expect(sendRemoteRuntimeRequestMock.mock.calls.map((call) => call[1])).toEqual([
      'status.get',
      'orchestration.federationPull'
    ])
    expect(sendRemoteRuntimeRequestMock).toHaveBeenLastCalledWith(
      expect.any(Object),
      'orchestration.federationPull',
      { dispatchId: 'dispatch-1', afterSequence: 0, limit: 50 },
      15_000,
      envelope,
      undefined,
      ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES
    )
    expect(sendRemoteRuntimeSharedControlRequestMock).not.toHaveBeenCalled()
  })
})
