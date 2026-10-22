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

import type { SshTarget } from '../../../shared/ssh-types'
import { setRefusedPairingHandlers } from '../runtime-environments/runtime-environment-pairing-refusal-registry'
import { createSshIpcHarness } from './ssh-ipc-test-harness'

const managedTarget: SshTarget = {
  id: 'ssh-1',
  label: 'Server',
  host: 'example.com',
  port: 22,
  username: 'deploy',
  orcadFence: { environmentId: 'env-managed' }
}

describe('ssh:connect and a held managed re-pair failure', () => {
  const harness = createSshIpcHarness(mocks)
  const { handlers } = harness
  const connectRequested = vi.fn()

  beforeEach(async () => {
    await harness.reset()
    connectRequested.mockReset()
    mocks.mockSshStore.getTarget.mockReturnValue(managedTarget)
    setRefusedPairingHandlers({
      recover: () => null,
      sharedControl: () => null,
      connectRequested
    })
  })

  it('an explicit connect clears the hold and cap for the managed server', async () => {
    await handlers.get('ssh:connect')!(null, { targetId: managedTarget.id })

    expect(connectRequested).toHaveBeenCalledWith('env-managed')
  })

  it('an automatic connect such as startup restore leaves them in place', async () => {
    await handlers.get('ssh:connect')!(null, { targetId: managedTarget.id, automatic: true })

    expect(connectRequested).not.toHaveBeenCalled()
  })
})
