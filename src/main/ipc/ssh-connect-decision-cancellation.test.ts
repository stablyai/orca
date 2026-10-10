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

import type { SshTarget } from '../../shared/ssh-types'
import type { SshConnection } from '../ssh/ssh-connection'
import { recordSshConnectionOpened } from '../ssh/ssh-connection-attribution'
import {
  decideHostServer,
  publishHostServerDecisionFailure
} from './ssh-host-server-connect'
import { createSshIpcHarness } from './ssh-ipc-test-harness'

const { mockSshStore, mockConnectionManager } = mocks

describe('a connect cancelled during its server decision', () => {
  const harness = createSshIpcHarness(mocks)
  const { handlers } = harness

  beforeEach(harness.reset)

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
      return { route: 'relay', reason: 'failed' }
    })
    await expect(
      Promise.resolve(handlers.get('ssh:connect')!(null, { targetId: 'ssh-1' }))
    ).rejects.toThrow('SSH connection attempt was cancelled')
    expect(mockConnectionManager.disconnectConnection).toHaveBeenCalledWith('ssh-1', opened)
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
