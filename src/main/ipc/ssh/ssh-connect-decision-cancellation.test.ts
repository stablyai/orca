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
vi.mock(import('../../ssh/legacy-relay/legacy-relay-bridge-registry'), async (importOriginal) => ({
  ...(await importOriginal()),
  startLegacyRelayBridge: vi.fn(async () => {}),
  stopLegacyRelayBridge: vi.fn()
}))

import type { SshTarget } from '../../../shared/ssh-types'
import type { SshConnection } from '../../ssh/connection/ssh-connection'
import { recordSshConnectionOpened } from '../../ssh/connection/ssh-connection-attribution'
import { decideHostServer, publishManagedServerConnect } from './ssh-host-server-connect'
import {
  startLegacyRelayBridge,
  stopLegacyRelayBridge
} from '../../ssh/legacy-relay/legacy-relay-bridge-registry'
import { createSshIpcHarness } from './ssh-ipc-test-harness'

const { mockSshStore, mockConnectionManager } = mocks

describe('a connect cancelled during its server decision', () => {
  const harness = createSshIpcHarness(mocks)
  const { handlers } = harness

  beforeEach(harness.reset)

  it('does not publish connected when the user disconnected during the legacy bridge wait', async () => {
    const target: SshTarget = {
      id: 'ssh-1',
      label: 'Server',
      host: 'example.com',
      port: 22,
      username: 'deploy'
    }
    const opened = { id: 'managed-transport' }
    vi.mocked(publishManagedServerConnect).mockClear()
    mockSshStore.getTarget.mockReturnValue(target)
    mockConnectionManager.getConnection.mockReturnValue(undefined)
    mockConnectionManager.disconnect.mockResolvedValue(undefined)
    vi.mocked(decideHostServer).mockImplementationOnce(async () => {
      recordSshConnectionOpened(asTransport(opened))
      mockConnectionManager.getConnection.mockReturnValue(opened)
      return { route: 'managed', environmentId: 'env-1' }
    })
    vi.mocked(startLegacyRelayBridge).mockImplementationOnce(async () => {
      await handlers.get('ssh:disconnect')!(null, { targetId: 'ssh-1' })
    })
    await expect(
      Promise.resolve(handlers.get('ssh:connect')!(null, { targetId: 'ssh-1' }))
    ).rejects.toThrow('SSH connection attempt was cancelled')
    expect(publishManagedServerConnect).not.toHaveBeenCalled()
    expect(stopLegacyRelayBridge).toHaveBeenCalledWith('ssh-1')
  })
})

type FakeTransport = { id: string }

function asTransport(value: FakeTransport): SshConnection {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: attribution keys on identity only.
  return value as unknown as SshConnection
}
