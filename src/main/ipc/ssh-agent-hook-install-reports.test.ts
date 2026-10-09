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

import { createSshIpcHarness } from './ssh-ipc-test-harness'
import { getActiveSshAgentHookInstallReports } from './ssh'

const { mockSshStore, mockConnectionManager, mockMux } = mocks

describe('SSH hook installation visibility', () => {
  const harness = createSshIpcHarness(mocks)
  const { handlers } = harness
  beforeEach(harness.reset)

  it('keeps an active host visible while hook detection is pending', async () => {
    vi.stubEnv('ORCA_FEATURE_REMOTE_AGENT_HOOKS', '1')
    let resolveDetection!: (value: { agents: string[] }) => void
    const detection = new Promise<{ agents: string[] }>((resolve) => {
      resolveDetection = resolve
    })
    const defaultRequest = mockMux.request.getMockImplementation()
    mockMux.request.mockImplementation((method: string) =>
      method === 'preflight.detectAgents' ? detection : defaultRequest?.(method)
    )
    try {
      mockSshStore.getTarget.mockReturnValue({
        id: 'ssh-1',
        label: 'Server',
        host: 'example.com',
        port: 22,
        username: 'deploy'
      })
      mockConnectionManager.connect.mockResolvedValue({})
      mockConnectionManager.getState.mockReturnValue({
        targetId: 'ssh-1',
        status: 'connected',
        error: null,
        reconnectAttempt: 0
      })
      await handlers.get('ssh:connect')!(null, { targetId: 'ssh-1' })

      expect(getActiveSshAgentHookInstallReports()).toEqual([
        {
          targetId: 'ssh-1',
          remoteHome: null,
          state: 'unavailable',
          detail: 'remote hook installation check is in progress',
          statuses: []
        }
      ])
    } finally {
      resolveDetection({ agents: [] })
      vi.unstubAllEnvs()
    }
  })
})
