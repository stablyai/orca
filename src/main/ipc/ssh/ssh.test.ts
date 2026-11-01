import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = await vi.hoisted(async () => {
  const { createSshIpcMocks } = await import('./ssh-ipc-module-mocks')
  return createSshIpcMocks()
})

vi.mock('../../ssh/config/ssh-config-host-picker', () => mocks.sshConfigHostPicker)
vi.mock('electron', () => mocks.electron)
vi.mock('../../ssh/connection/ssh-connection-store', () => mocks.sshConnectionStore)
vi.mock('./ssh-host-server-connect', () => mocks.hostServerConnect)
vi.mock('../../ssh/connection/ssh-connection-manager', () => mocks.sshConnectionManager)
vi.mock('../../ssh/ssh-channel-multiplexer', () => mocks.sshChannelMultiplexer)
vi.mock('../../ssh/port-forwarding/ssh-port-forward', () => mocks.sshPortForward)
vi.mock('../ssh/ssh-port-scanner', () => mocks.sshPortScanner)

import type { SshConnectionState, SshTarget } from '../../../shared/ssh-types'
import { createSshIpcHarness } from './ssh-ipc-test-harness'
import {
  decideHostServer,
  publishManagedServerConnect,
  publishUnservedHostServer
} from './ssh-host-server-connect'
import {
  beginSshHostCensus,
  recordSshConnectionOpened
} from '../../ssh/connection/ssh-connection-attribution'
import type { SshConnection } from '../../ssh/connection/ssh-connection'
import { clearSshHostServerStatus, setSshHostServerStatus } from '../../ssh/ssh-host-server-status'

const { mockSshStore, mockConnectionManager } = mocks

const target: SshTarget = {
  id: 'ssh-1',
  label: 'Server',
  host: 'example.com',
  port: 22,
  username: 'deploy'
}

function asTransport(value: { id: string }): SshConnection {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: attribution keys on identity only.
  return value as unknown as SshConnection
}

describe('SSH IPC handlers', () => {
  const harness = createSshIpcHarness(mocks)
  const { handlers, mockWindow } = harness

  beforeEach(harness.reset)

  it('ssh:connect throws for unknown targetId', async () => {
    mockSshStore.getTarget.mockReturnValue(undefined)

    await expect(handlers.get('ssh:connect')!(null, { targetId: 'unknown' })).rejects.toThrow(
      'SSH target "unknown" not found'
    )
  })

  it('publishes a managed connect without opening a relay', async () => {
    mockSshStore.getTarget.mockReturnValue(target)

    await expect(handlers.get('ssh:connect')!(null, { targetId: 'ssh-1' })).resolves.toMatchObject({
      status: 'connected'
    })
    expect(publishManagedServerConnect).toHaveBeenCalledWith(
      'ssh-1',
      'env-test',
      undefined,
      undefined,
      undefined,
      undefined
    )
    expect(mockConnectionManager.connect).not.toHaveBeenCalled()
  })

  it('fails a host the managed server does not serve, with no fallback', async () => {
    const decision = {
      route: 'unserved' as const,
      reason: 'orcad_unavailable' as const,
      detail: 'unsupported_host'
    }
    const opened = { id: 'decision-transport' }
    mockSshStore.getTarget.mockReturnValue(target)
    vi.mocked(decideHostServer).mockImplementationOnce(async () => {
      recordSshConnectionOpened(asTransport(opened))
      mockConnectionManager.getConnection.mockReturnValue(opened)
      return decision
    })

    await expect(handlers.get('ssh:connect')!(null, { targetId: 'ssh-1' })).rejects.toThrow(
      'This SSH host isn’t supported'
    )
    expect(publishUnservedHostServer).toHaveBeenCalledWith(target, decision)
    expect(mockConnectionManager.disconnectConnection).toHaveBeenCalledWith('ssh-1', opened)
    expect(mockConnectionManager.connect).not.toHaveBeenCalled()
  })

  it('holds a raw connected the server decision causes', async () => {
    const conn = { hasCachedCredential: () => false }
    mockSshStore.getTarget.mockReturnValue(target)
    mockConnectionManager.getConnection.mockReturnValue(conn)
    let broadcastsDuringDecision: unknown[] = []
    vi.mocked(decideHostServer).mockImplementationOnce(async () => {
      await Promise.resolve()
      const callbacks = mockConnectionManager.callbacksRef.current as {
        onStateChange: (targetId: string, state: SshConnectionState) => void
      }
      callbacks.onStateChange('ssh-1', {
        targetId: 'ssh-1',
        status: 'connected',
        error: null,
        reconnectAttempt: 0
      })
      broadcastsDuringDecision = mockWindow.webContents.send.mock.calls
        .filter(([channel]) => channel === 'ssh:state-changed')
        .map(([, payload]) => payload)
      return { route: 'managed', environmentId: 'env-test' }
    })

    await handlers.get('ssh:connect')!(null, { targetId: 'ssh-1' })
    expect(broadcastsDuringDecision).not.toContainEqual(
      expect.objectContaining({ state: expect.objectContaining({ status: 'connected' }) })
    )
    expect(broadcastsDuringDecision.at(-1)).toMatchObject({ state: { status: 'connecting' } })
  })

  it("holds a census's raw 'connected' outside any connect", () => {
    const end = beginSshHostCensus('ssh-1')
    try {
      const callbacks = mockConnectionManager.callbacksRef.current as {
        onStateChange: (targetId: string, state: SshConnectionState) => void
      }
      mockWindow.webContents.send.mockClear()
      callbacks.onStateChange('ssh-1', {
        targetId: 'ssh-1',
        status: 'connected',
        error: null,
        reconnectAttempt: 0
      })
      expect(mockWindow.webContents.send).toHaveBeenCalledWith(
        'ssh:state-changed',
        expect.objectContaining({ state: expect.objectContaining({ status: 'connecting' }) })
      )
    } finally {
      end()
    }
  })

  // Tunnel startup can serve a host without an SSH connect, so connect-only restoration left saved forwards off (#32484).
  it.each([
    { kind: 'managed', environmentId: 'env-test' } as const,
    { kind: 'relay', reason: 'orcad_unavailable', bridged: true } as const
  ])('restores saved forwards whenever a $kind status is published', async (status) => {
    const conn = { id: 'conn-1', getConnectGeneration: () => 1 }
    mockSshStore.getTarget.mockReturnValue({
      ...target,
      portForwards: [{ localPort: 8080, remoteHost: '127.0.0.1', remotePort: 3000 }]
    })
    mockConnectionManager.getConnection.mockReturnValue(conn)
    clearSshHostServerStatus('ssh-1')
    try {
      setSshHostServerStatus('ssh-1', status)
      await vi.waitFor(() =>
        expect(mocks.mockPortForwardManager.addForward).toHaveBeenCalledWith(
          'ssh-1',
          conn,
          8080,
          '127.0.0.1',
          3000,
          undefined
        )
      )
    } finally {
      clearSshHostServerStatus('ssh-1')
    }
  })

  it('leaves saved forwards alone while the server decision is unsettled', async () => {
    mockSshStore.getTarget.mockReturnValue({
      ...target,
      portForwards: [{ localPort: 8080, remoteHost: '127.0.0.1', remotePort: 3000 }]
    })
    mockConnectionManager.getConnection.mockReturnValue({
      id: 'conn-1',
      getConnectGeneration: () => 1
    })
    try {
      setSshHostServerStatus('ssh-1', { kind: 'setting-up', phase: 'deploying' })
      setSshHostServerStatus('ssh-1', { kind: 'relay', reason: 'orcad_unavailable' })
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(mocks.mockPortForwardManager.addForward).not.toHaveBeenCalled()
    } finally {
      clearSshHostServerStatus('ssh-1')
    }
  })
})
