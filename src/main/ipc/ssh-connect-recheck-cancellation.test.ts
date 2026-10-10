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
vi.mock('../ssh/ssh-relay-deploy', () => mocks.sshRelayDeploy)
vi.mock('../ssh/ssh-relay-reset', () => mocks.sshRelayReset)
vi.mock('../ssh/ssh-channel-multiplexer', () => mocks.sshChannelMultiplexer)
vi.mock('../providers/ssh-pty-provider', () => mocks.sshPtyProvider)
vi.mock('../providers/ssh-filesystem-provider', () => mocks.sshFilesystemProvider)
vi.mock('./pty', () => mocks.pty)
vi.mock('../providers/ssh-filesystem-dispatch', () => mocks.sshFilesystemDispatch)
vi.mock('../providers/ssh-git-provider', () => mocks.sshGitProvider)
vi.mock('../providers/ssh-git-dispatch', () => mocks.sshGitDispatch)
vi.mock('../ssh/ssh-port-forward', () => mocks.sshPortForward)
vi.mock('../ssh/ssh-port-scanner', () => mocks.sshPortScanner)

import type { SshTarget } from '../../shared/ssh-types'
import type { SshConnection } from '../ssh/ssh-connection'
import { recordSshConnectionOpened } from '../ssh/ssh-connection-attribution'
import {
  decideHostServer,
  publishHostServerDecisionFailure,
  refineRelayTerminalDecision
} from './ssh-host-server-connect'
import { createSshIpcHarness } from './ssh-ipc-test-harness'

const { mockSshStore, mockConnectionManager, mockDeployAndLaunchRelay } = mocks

describe('a connect cancelled during the relay-terminal re-check', () => {
  const harness = createSshIpcHarness(mocks)
  const { handlers, createRelayLaunchResult } = harness

  beforeEach(harness.reset)

  it('never reports connected for a connect cancelled during the relay-terminal re-check', async () => {
    const target: SshTarget = {
      id: 'ssh-1',
      label: 'Server',
      host: 'example.com',
      port: 22,
      username: 'deploy'
    }
    const conn = { id: 'rechecking-transport' }
    let releaseRecheck = (): void => {}
    mockSshStore.getTarget.mockReturnValue(target)
    mockConnectionManager.getConnection.mockReturnValue(undefined)
    mockConnectionManager.connect.mockResolvedValue(conn)
    mockConnectionManager.disconnect.mockResolvedValue(undefined)
    mockDeployAndLaunchRelay.mockResolvedValueOnce(createRelayLaunchResult())
    vi.mocked(refineRelayTerminalDecision).mockImplementationOnce(
      () => new Promise<void>((resolve) => (releaseRecheck = resolve))
    )
    const connect = Promise.resolve(handlers.get('ssh:connect')!(null, { targetId: 'ssh-1' }))
    await vi.waitFor(() => expect(refineRelayTerminalDecision).toHaveBeenCalled())
    await handlers.get('ssh:disconnect')!(null, { targetId: 'ssh-1' })
    releaseRecheck()

    await expect(connect).rejects.toThrow('SSH connection attempt was cancelled')
    expect(mockConnectionManager.disconnectConnection).toHaveBeenCalledWith('ssh-1', conn)
  })

  it('publishes the error when a managed host fails to set up, rather than staying connecting', async () => {
    const target: SshTarget = {
      id: 'ssh-1',
      label: 'Server',
      host: 'example.com',
      port: 22,
      username: 'deploy'
    }
    const failure = new Error('listen EADDRINUSE 127.0.0.1:46768')
    mockSshStore.getTarget.mockReturnValue(target)
    vi.mocked(decideHostServer).mockRejectedValueOnce(failure)
    await expect(handlers.get('ssh:connect')!(null, { targetId: 'ssh-1' })).rejects.toBe(failure)
    expect(publishHostServerDecisionFailure).toHaveBeenCalledWith('ssh-1', failure)
  })

  it('publishes the setup failure when a failed setup kept the host fenced', async () => {
    const target: SshTarget = {
      id: 'ssh-1',
      label: 'Server',
      host: 'example.com',
      port: 22,
      username: 'deploy',
      orcadFence: { environmentId: 'env-1' }
    }
    mockSshStore.getTarget.mockReturnValue(target)
    vi.mocked(decideHostServer).mockResolvedValueOnce({
      route: 'relay',
      reason: 'failed',
      detail: 'The destination could not stage the migration.'
    })
    await expect(handlers.get('ssh:connect')!(null, { targetId: 'ssh-1' })).rejects.toThrow(
      'The destination could not stage the migration.'
    )
    expect(publishHostServerDecisionFailure).toHaveBeenCalledWith(
      'ssh-1',
      expect.objectContaining({ message: 'The destination could not stage the migration.' })
    )
  })

  it('closes a transport the cancelled decision opened after the user disconnected', async () => {
    const target: SshTarget = {
      id: 'ssh-1',
      label: 'Server',
      host: 'example.com',
      port: 22,
      username: 'deploy'
    }
    const opened = { id: 'census-transport' }
    mockSshStore.getTarget.mockReturnValue(target)
    mockConnectionManager.getConnection.mockReturnValue(undefined)
    mockConnectionManager.disconnect.mockResolvedValue(undefined)
    vi.mocked(decideHostServer).mockImplementationOnce(async () => {
      // The real decision awaits its module loads before any census, as here.
      await Promise.resolve()
      await handlers.get('ssh:disconnect')!(null, { targetId: 'ssh-1' })
      // The census dials after the teardown, opening a transport no one else holds.
      recordSshConnectionOpened(asTransport(opened))
      mockConnectionManager.getConnection.mockReturnValue(opened)
      return null
    })
    await expect(
      Promise.resolve(handlers.get('ssh:connect')!(null, { targetId: 'ssh-1' }))
    ).rejects.toThrow('SSH connection attempt was cancelled')
    expect(mockConnectionManager.disconnectConnection).toHaveBeenCalledWith('ssh-1', opened)
  })

  it('leaves a transport a completed replacement connect adopted from the stale decision', async () => {
    const target: SshTarget = {
      id: 'ssh-1',
      label: 'Server',
      host: 'example.com',
      port: 22,
      username: 'deploy'
    }
    const opened = { id: 'shared-transport' }
    mockSshStore.getTarget.mockReturnValue(target)
    mockConnectionManager.getConnection.mockReturnValue(undefined)
    mockConnectionManager.disconnect.mockResolvedValue(undefined)
    mockConnectionManager.connect.mockResolvedValue(opened)
    mockDeployAndLaunchRelay.mockResolvedValue(createRelayLaunchResult())
    let resumeStale = (): void => {}
    let staleDecided = false
    vi.mocked(decideHostServer).mockImplementationOnce(async () => {
      await Promise.resolve()
      staleDecided = true
      recordSshConnectionOpened(asTransport(opened))
      mockConnectionManager.getConnection.mockReturnValue(opened)
      await new Promise<void>((resolve) => (resumeStale = resolve))
      return null
    })
    const stale = Promise.resolve(handlers.get('ssh:connect')!(null, { targetId: 'ssh-1' }))
    await vi.waitFor(() => expect(staleDecided).toBe(true))
    await handlers.get('ssh:disconnect')!(null, { targetId: 'ssh-1' })
    // The replacement reuses the pooled transport and completes, leaving connectInFlight.
    await handlers.get('ssh:connect')!(null, { targetId: 'ssh-1' })
    mockConnectionManager.disconnectConnection.mockClear()
    resumeStale()
    await expect(stale).rejects.toThrow('SSH connection attempt was cancelled')
    expect(mockConnectionManager.disconnectConnection).not.toHaveBeenCalledWith('ssh-1', opened)
  })

  it('closes the transport a still-current decision dialed when that decision fails', async () => {
    const target: SshTarget = {
      id: 'ssh-1',
      label: 'Server',
      host: 'example.com',
      port: 22,
      username: 'deploy',
      orcadFence: { environmentId: 'env-1' }
    }
    const opened = { id: 'tunnel-transport' }
    const failure = new Error('listen EADDRINUSE 127.0.0.1:46768')
    mockSshStore.getTarget.mockReturnValue(target)
    mockConnectionManager.getConnection.mockReturnValue(undefined)
    vi.mocked(decideHostServer).mockImplementationOnce(async () => {
      await Promise.resolve()
      recordSshConnectionOpened(asTransport(opened))
      mockConnectionManager.getConnection.mockReturnValue(opened)
      throw failure
    })
    await expect(
      Promise.resolve(handlers.get('ssh:connect')!(null, { targetId: 'ssh-1' }))
    ).rejects.toBe(failure)
    expect(mockConnectionManager.disconnectConnection).toHaveBeenCalledWith('ssh-1', opened)
  })

  it('closes the transport a fenced failed setup dialed before reporting it', async () => {
    const target: SshTarget = {
      id: 'ssh-1',
      label: 'Server',
      host: 'example.com',
      port: 22,
      username: 'deploy',
      orcadFence: { environmentId: 'env-1' }
    }
    const opened = { id: 'conversion-transport' }
    mockSshStore.getTarget.mockReturnValue(target)
    mockConnectionManager.getConnection.mockReturnValue(undefined)
    vi.mocked(decideHostServer).mockImplementationOnce(async () => {
      await Promise.resolve()
      recordSshConnectionOpened(asTransport(opened))
      mockConnectionManager.getConnection.mockReturnValue(opened)
      return { route: 'relay', reason: 'failed', detail: 'Staging failed.' }
    })
    await expect(
      Promise.resolve(handlers.get('ssh:connect')!(null, { targetId: 'ssh-1' }))
    ).rejects.toThrow('Staging failed.')
    expect(mockConnectionManager.disconnectConnection).toHaveBeenCalledWith('ssh-1', opened)
  })
})

/** The stand-in transports these tests hand the mocked pool. */
type FakeTransport = { id: string }

function asTransport(value: FakeTransport): SshConnection {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: attribution keys on identity only.
  return value as unknown as SshConnection
}
