import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SkillInstallRequest } from '../../shared/skill-install-contract'
import { resolveSkillInstallDestination } from './skill-install-destinations'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'orca-skill-destination-test-'))
  roots.push(root)
  const home = join(root, 'home')
  const worktree = join(root, 'worktree')
  const folder = join(root, 'folder')
  await Promise.all([mkdir(home), mkdir(worktree), mkdir(folder)])
  return {
    home,
    worktree,
    folder,
    authority: {
      environmentId: 'environment_1',
      homeDirectory: await realpath(home),
      resolveWorktree: async (id: string) => (id === 'worktree_1' ? { id, path: worktree } : null),
      resolveFolderWorkspace: async (id: string) =>
        id === 'folder_1' ? { id, path: folder } : null,
      resolveWsl: async (distro: string) => (distro === 'Ubuntu' ? { homeDirectory: home } : null)
    }
  }
}

describe('resolveSkillInstallDestination', () => {
  it('derives global paths from host-owned home and environment identity', async () => {
    const { authority } = await fixture()
    await expect(
      resolveSkillInstallDestination(
        { scope: 'global', environmentId: 'environment_1', executionTarget: { kind: 'host' } },
        authority
      )
    ).resolves.toEqual({
      scope: 'global',
      homeDirectory: authority.homeDirectory,
      destinationIdentity: 'global:environment_1'
    })
  })

  it.each([
    [{ scope: 'workspace', worktreeId: 'worktree_1' }, 'worktree'],
    [{ scope: 'workspace', folderWorkspaceId: 'folder_1' }, 'folder']
  ] as const)('resolves %s identity without accepting a caller path', async (destination, key) => {
    const fixtureValue = await fixture()
    const result = await resolveSkillInstallDestination(
      destination as SkillInstallRequest['destination'],
      fixtureValue.authority
    )
    expect(result.workspaceDirectory).toBe(await realpath(fixtureValue[key]))
  })

  it('rejects another environment and unknown workspace before filesystem mutation', async () => {
    const { authority } = await fixture()
    await expect(
      resolveSkillInstallDestination({ scope: 'global', environmentId: 'other' }, authority)
    ).rejects.toThrow('skill-install-environment-mismatch')
    await expect(
      resolveSkillInstallDestination({ scope: 'workspace', worktreeId: 'missing' }, authority)
    ).rejects.toThrow('skill-install-workspace-not-found')
  })

  it('resolves a selected WSL distro through host-owned authority', async () => {
    const { authority } = await fixture()
    await expect(
      resolveSkillInstallDestination(
        { scope: 'global', executionTarget: { kind: 'wsl', distro: 'Ubuntu' } },
        authority
      )
    ).resolves.toMatchObject({
      scope: 'global',
      homeDirectory: authority.homeDirectory,
      destinationIdentity: 'global:environment_1:wsl:Ubuntu',
      wslDistro: 'Ubuntu'
    })
  })

  it('never substitutes the desktop home for an SSH target', async () => {
    const { authority } = await fixture()
    await expect(
      resolveSkillInstallDestination(
        { scope: 'global', executionTarget: { kind: 'ssh', connectionId: 'ssh_1' } },
        authority
      )
    ).rejects.toThrow('skill-install-ssh-dispatch-required')
  })
})
