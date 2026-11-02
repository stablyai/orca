import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SshTarget } from '../../../shared/ssh-types'
import { fingerprintRuntimeSshTarget } from '../../ssh/runtime-ssh-target-fingerprint'

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

const released: SshTarget = {
  id: 'ssh-1',
  label: 'Box',
  host: 'box',
  port: 22,
  username: 'me',
  generation: 1
}
const target: SshTarget = { ...released, orcadFence: { environmentId: 'env-1' } }
const access = {
  sshTargetId: 'ssh-1',
  sshTargetGeneration: 1,
  remotePort: 6768,
  targetFingerprint: fingerprintRuntimeSshTarget(target)
}

beforeEach(() => vi.clearAllMocks())

describe('connecting the SSH host a paired server uses only for its ports', () => {
  it('dials only the SSH connection once linked, never deciding a server', async () => {
    mocks.environments = [{ id: 'env-1', sshAccess: { ...access, portsOnly: true } }]
    await expect(decideHostServer(target)).resolves.toEqual({
      route: 'managed',
      environmentId: 'env-1'
    })
    expect(mocks.connect).toHaveBeenCalledWith(target)
    expect(mocks.resolve).not.toHaveBeenCalled()
  })

  it.each([
    ['linking', 'link', target],
    ['stopping', 'unlink', target],
    // An unlink can stop after releasing the host's fence and before it completes.
    ['stopping past the release', 'unlink', released]
  ])('refuses the host while %s is unfinished, so no forwards restore', async (_s, op, host) => {
    mocks.environments = [
      {
        id: 'env-1',
        name: 'Lab',
        pendingSshAccessOperation: { ...access, operation: op, portsOnly: true }
      }
    ]
    await expect(decideHostServer(host)).rejects.toThrow(
      "The SSH access change for Lab didn't finish."
    )
    expect(mocks.connect).not.toHaveBeenCalled()
    expect(mocks.resolve).not.toHaveBeenCalled()
  })

  it('decides the server of a released host edited since, which Retry can no longer finish', async () => {
    mocks.environments = [
      {
        id: 'env-1',
        name: 'Lab',
        pendingSshAccessOperation: { ...access, operation: 'unlink', portsOnly: true }
      }
    ]
    await decideHostServer({ ...released, host: 'box.example' })
    expect(mocks.resolve).toHaveBeenCalledOnce()
  })

  it('still decides the server of a host whose SSH access carries the connection', async () => {
    mocks.environments = [{ id: 'env-1', sshAccess: access }]
    await decideHostServer(target)
    expect(mocks.resolve).toHaveBeenCalledOnce()
    expect(mocks.connect).not.toHaveBeenCalled()
  })
})
