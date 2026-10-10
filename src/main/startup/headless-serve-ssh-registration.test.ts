import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = await vi.hoisted(async () => {
  const { createSshIpcMocks } = await import('../ipc/ssh-ipc-module-mocks')
  return createSshIpcMocks()
})

vi.mock('../ssh/ssh-config-host-picker', () => mocks.sshConfigHostPicker)
vi.mock('electron', () => mocks.electron)
vi.mock('../ipc/ssh-pty-output-intake-registry', () => mocks.sshPtyOutputIntakeRegistry)
vi.mock('../ssh/ssh-connection-store', () => mocks.sshConnectionStore)
vi.mock('../ipc/ssh-host-server-connect', () => mocks.hostServerConnect)
vi.mock('../ssh/ssh-connection-manager', () => mocks.sshConnectionManager)
vi.mock('../ssh/ssh-relay-deploy', () => mocks.sshRelayDeploy)
vi.mock('../ssh/ssh-relay-reset', () => mocks.sshRelayReset)
vi.mock('../ssh/ssh-channel-multiplexer', () => mocks.sshChannelMultiplexer)
vi.mock('../providers/ssh-pty-provider', () => mocks.sshPtyProvider)
vi.mock('../providers/ssh-filesystem-provider', () => mocks.sshFilesystemProvider)
vi.mock('../ipc/pty', () => mocks.pty)
vi.mock('../providers/ssh-filesystem-dispatch', () => mocks.sshFilesystemDispatch)
vi.mock('../providers/ssh-git-provider', () => mocks.sshGitProvider)
vi.mock('../providers/ssh-git-dispatch', () => mocks.sshGitDispatch)
vi.mock('../ssh/ssh-port-forward', () => mocks.sshPortForward)
vi.mock('../ssh/ssh-port-scanner', () => mocks.sshPortScanner)

import { resetSshHandlerStateForTests } from '../ipc/ssh'
import { connectRegisteredSshTarget, listRegisteredSshTargets } from '../ssh/ssh-target-registry'
import { createSshIpcHarness } from '../ipc/ssh-ipc-test-harness'
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
    await expect(connectRegisteredSshTarget('ssh-1')).rejects.toThrow('ssh_handlers_not_registered')
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
