import { resetRuntimeEnvironmentStatusOwners } from './runtime-environment-request-connections'
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }))
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createSharedControlTestServer,
  closeSharedControlTestServers
} from '../../../shared/remote-runtime/control/remote-runtime-shared-control-test-server'
import type { sendRemoteRuntimeRequestWithStatusPreflight as StatusPreflight } from '../../../shared/remote-runtime/remote-runtime-client'
import { encodePairingOffer } from '../../../shared/remote-runtime/pairing/pairing'
import { REMOTE_RUNTIME_SHARED_CONTROL_CAPABILITY } from '../../../shared/protocol-version'
import { ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES } from '../../../shared/electron-remote-runtime-client-capabilities'
import {
  addEnvironmentFromPairingCode,
  markEnvironmentUsed
} from '../../../shared/remote-runtime/host-store/runtime-environment-store'

const {
  sendRemoteRuntimeRequestMock,
  sendRemoteRuntimeRequestWithStatusPreflightMock,
  sendRemoteRuntimeSharedControlRequestMock
} = vi.hoisted(() => ({
  sendRemoteRuntimeRequestMock: vi.fn(),
  sendRemoteRuntimeRequestWithStatusPreflightMock: vi.fn(),
  sendRemoteRuntimeSharedControlRequestMock: vi.fn()
}))

vi.mock('../../../shared/remote-runtime/remote-runtime-client', () => ({
  sendRemoteRuntimeRequest: sendRemoteRuntimeRequestMock,
  sendRemoteRuntimeRequestWithStatusPreflight: sendRemoteRuntimeRequestWithStatusPreflightMock
}))

vi.mock('./runtime-environment-request-connections', async () => {
  const { withRuntimeStatusOwners } = await import('./runtime-environments-ipc-test-harness')
  return withRuntimeStatusOwners({
    sendRemoteRuntimeConnectionRequest: vi.fn(),
    sendRemoteRuntimeSharedControlRequest: sendRemoteRuntimeSharedControlRequestMock,
    reconnectRemoteRuntimeSharedControlConnection: vi.fn(),
    ensureRemoteRuntimeSharedControlConnection: vi.fn(),
    pauseRemoteRuntimeSharedControlRetry: vi.fn()
  })
})

import { callRuntimeEnvironment } from './runtime-environment-transport-routing'
import { resetSharedControlSupport } from './runtime-environment-shared-control-support'

const actual = await vi.importActual<{
  sendRemoteRuntimeRequestWithStatusPreflight: typeof StatusPreflight
}>('../../../shared/remote-runtime/remote-runtime-client')

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
    sendRemoteRuntimeRequestWithStatusPreflightMock.mockReset()
    sendRemoteRuntimeSharedControlRequestMock.mockReset()
  })

  afterEach(async () => {
    await closeSharedControlTestServers()
    resetRuntimeEnvironmentStatusOwners()
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

  it.each([
    ['orchestration.federationAck', { dispatchId: 'dispatch-1', throughSequence: 4 }],
    ['orchestration.federationImport', { dispatchId: 'dispatch-1', items: [] }]
  ])(
    'routes enveloped %s over shared control with its authority intact',
    async (method, params) => {
      const envelope = { orchestrationContractVersion: 1, orchestrationRequestId: 'relay-1' }
      sendRemoteRuntimeRequestMock.mockResolvedValue({
        id: 'status',
        ok: true,
        result: { capabilities: [REMOTE_RUNTIME_SHARED_CONTROL_CAPABILITY] },
        _meta: { runtimeId: 'runtime-worker' }
      })
      sendRemoteRuntimeSharedControlRequestMock.mockResolvedValue({
        id: 'relay',
        ok: true,
        result: { acknowledgedThrough: 4 },
        _meta: { runtimeId: 'runtime-worker' }
      })

      await callRuntimeEnvironment(
        userDataPath,
        environmentId,
        method,
        params,
        15_000,
        undefined,
        envelope
      )

      expect(sendRemoteRuntimeRequestMock.mock.calls.map((call) => call[1])).toEqual(['status.get'])
      expect(sendRemoteRuntimeSharedControlRequestMock).toHaveBeenCalledWith(
        environmentId,
        expect.any(Object),
        method,
        params,
        15_000,
        envelope
      )
    }
  )

  it.each([
    ['orchestration.federationAck', { dispatchId: 'dispatch-1', throughSequence: 4 }],
    ['orchestration.federationImport', { dispatchId: 'dispatch-1', items: [] }]
  ])('falls back to one-shot for %s when the host lacks shared control', async (method, params) => {
    const envelope = { orchestrationContractVersion: 1, orchestrationRequestId: 'relay-1' }
    sendRemoteRuntimeRequestMock.mockImplementation(async (_pairing, calledMethod) => ({
      id: calledMethod,
      ok: true,
      result: calledMethod === 'status.get' ? { capabilities: [] } : { acknowledgedThrough: 4 },
      _meta: { runtimeId: 'runtime-worker' }
    }))

    await callRuntimeEnvironment(
      userDataPath,
      environmentId,
      method,
      params,
      15_000,
      undefined,
      envelope
    )

    expect(sendRemoteRuntimeRequestMock.mock.calls.map((call) => call[1])).toEqual([
      'status.get',
      method
    ])
    expect(sendRemoteRuntimeRequestMock).toHaveBeenLastCalledWith(
      expect.any(Object),
      method,
      params,
      15_000,
      envelope,
      undefined,
      ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES
    )
    expect(sendRemoteRuntimeSharedControlRequestMock).not.toHaveBeenCalled()
  })

  it('refuses a runtime-pinned one-shot mutation when its socket reaches a restarted host', async () => {
    const server = await createSharedControlTestServer({
      resultForRequest: (method) =>
        method === 'status.get' ? { runtimeId: 'runtime-restarted', capabilities: [] } : {}
    })
    const paired = addEnvironmentFromPairingCode(userDataPath, {
      name: 'Restarted host',
      pairingCode: encodePairingOffer(server.offer)
    })
    markEnvironmentUsed(userDataPath, paired.id, { runtimeId: 'runtime-proven' })
    sendRemoteRuntimeRequestWithStatusPreflightMock.mockImplementation(
      actual.sendRemoteRuntimeRequestWithStatusPreflight
    )
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
