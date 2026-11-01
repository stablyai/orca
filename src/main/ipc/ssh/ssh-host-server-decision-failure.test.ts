import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SshTarget } from '../../../shared/ssh-types'

const mocks = vi.hoisted(() => ({
  getTarget: vi.fn(),
  resolve: vi.fn()
}))
vi.mock('../../../shared/app-environment', () => ({
  getAppEnvironment: () => ({ getPath: () => '/tmp/user-data', getVersion: () => '1.5.0' })
}))
vi.mock('../../ssh/targets/ssh-target-registry', () => ({
  getSshTargetRegistryStore: () => ({ getTarget: mocks.getTarget })
}))
vi.mock('../../ssh/ssh-host-server-on-connect', () => ({
  resolveHostServerOnConnect: mocks.resolve
}))
vi.mock('./ssh-host-server-on-connect-wiring', () => ({ hostServerOnConnectDeps: () => ({}) }))
vi.mock('./ssh-ipc-context', () => ({ connectionManager: null, getCurrentMainWindow: () => null }))
vi.mock('./ssh-renderer-broadcast', () => ({
  broadcastSshState: vi.fn(),
  clearRelayStateOverride: vi.fn(),
  getPublicSshState: vi.fn()
}))

const { decideHostServer, publishHostServerDecisionFailure } =
  await import('./ssh-host-server-connect')
const { broadcastSshState } = await import('./ssh-renderer-broadcast')
const { getSshHostServerStatus, setSshHostServerStatus } =
  await import('../../ssh/ssh-host-server-status')
const { markSshSessionStartFailure } = await import('../../ssh/ssh-session-start-failure')

const target: SshTarget = { id: 'ssh-1', label: 'Box', host: 'box', port: 22, username: 'me' }
const fenced: SshTarget = {
  ...target,
  orcadFence: { environmentId: 'env-1' }
}

beforeEach(() => vi.clearAllMocks())

describe('a managed-server decision that fails', () => {
  it('surfaces the real error on a host only its managed server can reach', async () => {
    mocks.getTarget.mockReturnValue(fenced)
    const auth = new Error('All configured authentication methods failed')
    mocks.resolve.mockRejectedValue(auth)
    await expect(decideHostServer(target)).rejects.toBe(auth)
  })

  it('replaces a stuck setting-up status with the error once setup fails', () => {
    setSshHostServerStatus('ssh-1', { kind: 'setting-up', phase: 'connecting' })
    publishHostServerDecisionFailure('ssh-1', new Error('listen EADDRINUSE'))
    expect(getSshHostServerStatus('ssh-1')).toBeUndefined()
    expect(vi.mocked(broadcastSshState).mock.calls.at(-1)?.[2]).toMatchObject({
      status: 'error',
      error: 'listen EADDRINUSE'
    })
  })

  it('leads a failed SSH session with what to do about it', () => {
    publishHostServerDecisionFailure(
      'ssh-1',
      markSshSessionStartFailure(new Error('connect ECONNREFUSED 10.0.0.1:22'))
    )
    expect(vi.mocked(broadcastSshState).mock.calls.at(-1)?.[2].error).toMatch(
      /^Nothing accepted the SSH connection at this address\..*\(connect ECONNREFUSED 10\.0\.0\.1:22\)$/
    )
  })
})
