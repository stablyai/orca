import { expect, it, vi } from 'vitest'
vi.mock('../../shared/ephemeral-vm-runtime-store', () => ({
  listEphemeralVmRuntimes: () => [{ id: 'one', sshTargetId: 'runtime-ssh-owner' }]
}))
vi.mock('../provisioned-root-ssh-adoption', () => ({
  adoptProvisionedRootSshCheckout: vi.fn(async (args) => ({
    current: args.isRepoCurrent(),
    request: args.request
  }))
}))
import { adoptEphemeralVmProvisionedRoot } from './ephemeral-vm-provisioned-root-host'
import { adoptProvisionedRootSshCheckout } from '../provisioned-root-ssh-adoption'
it('matches the trusted runtime owner while allowing freshly hydrated repository objects', async () => {
  const store = {
    getRepos: () => [{ id: 'repo', path: '/workspace/repo', connectionId: 'runtime-ssh-owner' }]
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the isolated fixture supplies the methods exercised by this ownership test.
  const result = await adoptEphemeralVmProvisionedRoot(store as never, () => '/profile', {
    repoId: 'repo',
    runtimeId: 'one',
    name: 'task',
    expectedPath: '/workspace/repo',
    executionHostId: 'ssh:attacker'
  } as never)
  expect(result).toMatchObject({
    current: true,
    request: { executionHostId: 'ssh:runtime-ssh-owner' }
  })
})
it('rejects a repository with the same id on a different target', async () => {
  vi.mocked(adoptProvisionedRootSshCheckout).mockClear()
  const store = {
    getRepos: () => [{ id: 'repo', path: '/workspace/repo', connectionId: 'runtime-ssh-other' }]
  }
  await expect(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the isolated fixture supplies the methods exercised by this ownership test.
    adoptEphemeralVmProvisionedRoot(store as never, () => '/profile', {
      repoId: 'repo',
      runtimeId: 'one'
    } as never)
  ).rejects.toThrow('no owning SSH target')
  expect(adoptProvisionedRootSshCheckout).not.toHaveBeenCalled()
})
