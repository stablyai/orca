import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = await vi.hoisted(async () => {
  const { createSshIpcMocks } = await import('../ipc/ssh/ssh-ipc-module-mocks')
  return createSshIpcMocks()
})

vi.mock('../ssh/config/ssh-config-host-picker', () => mocks.sshConfigHostPicker)
vi.mock('electron', () => mocks.electron)
vi.mock('../ssh/connection/ssh-connection-store', () => mocks.sshConnectionStore)
vi.mock('../ipc/ssh/ssh-host-server-connect', () => mocks.hostServerConnect)
vi.mock('../ssh/connection/ssh-connection-manager', () => mocks.sshConnectionManager)
vi.mock('../ssh/ssh-channel-multiplexer', () => mocks.sshChannelMultiplexer)
vi.mock('../ssh/port-forwarding/ssh-port-forward', () => mocks.sshPortForward)
vi.mock('../ssh/ssh-port-scanner', () => mocks.sshPortScanner)

import { resetSshHandlerStateForTests } from '../ipc/ssh/ssh'
import {
  connectRegisteredSshTarget,
  listRegisteredSshTargets,
  SSH_TARGET_MANAGEMENT_UNSERVED_MESSAGE
} from '../ssh/targets/ssh-target-registry'
import { createSshIpcHarness } from '../ipc/ssh/ssh-ipc-test-harness'
import type { SshTarget } from '../../shared/ssh-types'
import { mainProcessState } from './main-process-state'
import { registerHeadlessServeSshHandlers } from './headless-serve-ssh-registration'

const { mockSshStore, mockConnectionManager } = mocks
const target: SshTarget = {
  id: 'ssh-1',
  label: 'build box',
  host: 'build.example',
  port: 22,
  username: 'deploy'
}

describe('SSH registration on a headless `orca serve`', () => {
  const harness = createSshIpcHarness(mocks)

  beforeEach(async () => {
    await harness.reset()
    // Why: a headless serve never attached a window, so nothing registered the SSH layer.
    await resetSshHandlerStateForTests()
    mainProcessState.mainWindow = null
  })

  it('reproduces the unregistered host before bootstrap (#25886, #8489)', async () => {
    expect(listRegisteredSshTargets()).toEqual([])
    await expect(connectRegisteredSshTarget('ssh-1')).rejects.toThrow(
      SSH_TARGET_MANAGEMENT_UNSERVED_MESSAGE
    )
  })

  it('lists and connects persisted SSH targets with no window', async () => {
    mockSshStore.listTargets.mockReturnValue([target])
    mockSshStore.getTarget.mockReturnValue(target)
    mockConnectionManager.connect.mockResolvedValue({})
    mockConnectionManager.getState.mockReturnValue({
      targetId: 'ssh-1',
      status: 'connected',
      error: null,
      reconnectAttempt: 0
    })

    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the SSH harness store implements every method registerSshHandlers reads.
    registerHeadlessServeSshHandlers(harness.mockStore as never, {} as never)

    expect(listRegisteredSshTargets()).toEqual([target])
    await expect(connectRegisteredSshTarget('ssh-1')).resolves.toMatchObject({
      targetId: 'ssh-1',
      status: 'connected'
    })
    expect(harness.mockWindow.webContents.send).not.toHaveBeenCalled()
  })
})
