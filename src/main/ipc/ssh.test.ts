import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = await vi.hoisted(async () => {
  const { createSshIpcMocks } = await import('./ssh-ipc-module-mocks')
  return createSshIpcMocks()
})

vi.mock('../ssh/ssh-config-host-picker', () => mocks.sshConfigHostPicker)
vi.mock('electron', () => mocks.electron)
vi.mock('./ssh-pty-output-intake-registry', () => mocks.sshPtyOutputIntakeRegistry)
vi.mock('../ssh/ssh-connection-store', () => mocks.sshConnectionStore)
vi.mock('./ssh-host-server-connect', () => mocks.hostServerConnect)
vi.mock('../ssh/ssh-connection-manager', () => mocks.sshConnectionManager)
vi.mock('../ssh/ssh-channel-multiplexer', () => mocks.sshChannelMultiplexer)
vi.mock('../providers/ssh-pty-provider', () => mocks.sshPtyProvider)
vi.mock('../providers/ssh-filesystem-provider', () => mocks.sshFilesystemProvider)
vi.mock('./pty', () => mocks.pty)
vi.mock('../providers/ssh-filesystem-dispatch', () => mocks.sshFilesystemDispatch)
vi.mock('../providers/ssh-git-provider', () => mocks.sshGitProvider)
vi.mock('../providers/ssh-git-dispatch', () => mocks.sshGitDispatch)
vi.mock('../ssh/ssh-port-forward', () => mocks.sshPortForward)
vi.mock('../ssh/ssh-port-scanner', () => mocks.sshPortScanner)

import type { SshConnectionState, SshTarget } from '../../shared/ssh-types'
import { createSshIpcHarness } from './ssh-ipc-test-harness'
import {
  decideHostServer,
  publishManagedServerConnect,
  publishUnservedHostServer
} from './ssh-host-server-connect'
import { beginSshHostCensus, recordSshConnectionOpened } from '../ssh/ssh-connection-attribution'
import type { SshConnection } from '../ssh/ssh-connection'

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
      undefined
    )
    expect(mockConnectionManager.connect).not.toHaveBeenCalled()
  })

  it('fails a host the managed server does not serve, with no fallback', async () => {
    const decision = {
      route: 'relay' as const,
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
    const conn = {}
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
})
