import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SshTarget } from '../../../shared/ssh-types'

const mocks = vi.hoisted(() => {
  const environments: unknown[] = []
  return {
    environments,
    connect: vi.fn(async () => ({})),
    resolve: vi.fn(async () => ({ route: 'managed', environmentId: 'env-managed' }))
  }
})
vi.mock('../../../shared/app-environment', () => ({
  getAppEnvironment: () => ({ getPath: () => '/tmp/user-data', getVersion: () => '1.5.0' })
}))
vi.mock('../../../shared/runtime-environment-store', () => ({
  listEnvironments: () => mocks.environments
}))
vi.mock('../../ssh/ssh-host-server-on-connect', () => ({
  resolveHostServerOnConnect: mocks.resolve
}))
vi.mock('./ssh-host-server-on-connect-wiring', () => ({ hostServerOnConnectDeps: () => ({}) }))
vi.mock('./ssh-ipc-context', () => ({
  connectionManager: { connect: mocks.connect },
  getCurrentMainWindow: () => null
}))

const { decideHostServer } = await import('./ssh-host-server-connect')

const target: SshTarget = {
  id: 'ssh-1',
  label: 'Box',
  host: 'box',
  port: 22,
  username: 'me',
  orcadFence: { environmentId: 'env-1' }
}
const access = { sshTargetId: 'ssh-1', sshTargetGeneration: 1, remotePort: 6768 }

beforeEach(() => vi.clearAllMocks())

describe('connecting the SSH host a paired server uses only for its ports', () => {
  it.each([
    ['linked', { sshAccess: { ...access, portsOnly: true } }],
    ['still linking', { pendingSshAccessOperation: { ...access, portsOnly: true } }]
  ])('dials only the SSH connection when %s, never deciding a server', async (_state, link) => {
    mocks.environments = [{ id: 'env-1', ...link }]
    await expect(decideHostServer(target)).resolves.toEqual({
      route: 'managed',
      environmentId: 'env-1'
    })
    expect(mocks.connect).toHaveBeenCalledWith(target)
    expect(mocks.resolve).not.toHaveBeenCalled()
  })

  it('still decides the server of a host whose SSH access carries the connection', async () => {
    mocks.environments = [{ id: 'env-1', sshAccess: access }]
    await decideHostServer(target)
    expect(mocks.resolve).toHaveBeenCalledOnce()
    expect(mocks.connect).not.toHaveBeenCalled()
  })
})
