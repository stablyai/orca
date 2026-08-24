import { mkdir, mkdtemp, writeFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FolderWorkspace } from '../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../shared/project-group-types'
import {
  REPO_MANAGED_DERIVE_SSH_UNSUPPORTED,
  REPO_MANAGED_GROUP_REQUIRED,
  REPO_MANAGED_LOCAL_OBJECTS_MISSING,
  deriveRepoManagedFolderWorkspace,
  materializeRepoManagedCheckout,
  seedDerivedRepoProjectGitDirs
} from './repo-managed-derive'

vi.mock('../git/runner', () => ({
  gitExecFileAsync: vi.fn(async (args: string[]) => {
    const keyIndex = args.lastIndexOf('--get')
    const key = keyIndex !== -1 ? args[keyIndex + 1] : ''
    if (key === 'remote.origin.url') {
      return { stdout: 'https://example.com/manifest.git\n', stderr: '' }
    }
    if (args.includes('--abbrev-ref')) {
      return { stdout: 'main\n', stderr: '' }
    }
    if (args.includes('for-each-ref')) {
      return { stdout: 'main\n', stderr: '' }
    }
    return { stdout: '', stderr: '' }
  })
}))

let tempDirs: string[] = []

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'orca-repo-derive-'))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  vi.clearAllMocks()
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
  tempDirs = []
})

async function writeMinimalRepoTree(mainPath: string): Promise<void> {
  await mkdir(join(mainPath, '.repo', 'repo'), { recursive: true })
  await writeFile(join(mainPath, '.repo', 'repo', 'repo'), '#!/bin/sh\n')
  await writeFile(join(mainPath, '.repo', 'manifest.xml'), '<manifest />\n')
}

function repoManagedGroup(parentPath: string, overrides: Partial<ProjectGroup> = {}): ProjectGroup {
  return {
    id: 'group-1',
    name: 'AOSP',
    parentPath,
    connectionId: null,
    parentGroupId: null,
    createdFrom: 'repo-managed',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

function folderWorkspace(overrides: Partial<FolderWorkspace> = {}): FolderWorkspace {
  return {
    id: 'ws-1',
    projectGroupId: 'group-1',
    name: 'AOSP workspace',
    folderPath: '/tmp/task-a',
    connectionId: null,
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 1,
    lastActivityAt: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

describe('materializeRepoManagedCheckout', () => {
  it('runs repo init then sync and keeps the destination on success', async () => {
    const root = await tempRoot()
    const mainPath = join(root, 'main')
    const destPath = join(root, 'task-a')
    await writeMinimalRepoTree(mainPath)
    const commands: string[][] = []
    const phases: string[] = []

    await materializeRepoManagedCheckout({
      mainPath,
      destPath,
      onPhase: (phase) => {
        phases.push(phase)
      },
      runCommand: async ({ args }) => {
        commands.push([...args])
        return { code: 0, stdout: '', stderr: '' }
      }
    })

    const repoCommands = commands.filter((args) => args[0] === 'init' || args[0] === 'sync')
    expect(repoCommands[0]?.[0]).toBe('init')
    expect(repoCommands[0]).toContain('--reference')
    const manifestFlag = repoCommands[0]?.indexOf('-m') ?? -1
    expect(repoCommands[0]?.[manifestFlag + 1]).toBe('default.xml')
    expect(repoCommands[1]).toEqual([
      'sync',
      '--local-only',
      '--no-manifest-update',
      '--verbose',
      '-j8'
    ])
    expect(phases).toEqual(['preparing', 'init', 'seed', 'sync'])
    await expect(stat(destPath)).resolves.toBeTruthy()
  })

  it('deletes the destination when repo sync fails', async () => {
    const root = await tempRoot()
    const mainPath = join(root, 'main')
    const destPath = join(root, 'task-a')
    await writeMinimalRepoTree(mainPath)

    await expect(
      materializeRepoManagedCheckout({
        mainPath,
        destPath,
        runCommand: async ({ args }) => {
          if (args[0] === 'sync') {
            return { code: 1, stdout: '', stderr: 'network' }
          }
          return { code: 0, stdout: '', stderr: '' }
        }
      })
    ).rejects.toThrow(/repo sync failed/)

    await expect(stat(destPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('deletes the destination when repo init fails', async () => {
    const root = await tempRoot()
    const mainPath = join(root, 'main')
    const destPath = join(root, 'task-a')
    await writeMinimalRepoTree(mainPath)

    await expect(
      materializeRepoManagedCheckout({
        mainPath,
        destPath,
        runCommand: async ({ args }) => {
          if (args[0] === 'init') {
            return { code: 1, stdout: '', stderr: "fatal: manifest 'manifest.xml' not available" }
          }
          return { code: 0, stdout: '', stderr: '' }
        }
      })
    ).rejects.toThrow(/repo init failed/)

    await expect(stat(destPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses to overwrite an existing destination', async () => {
    const root = await tempRoot()
    const mainPath = join(root, 'main')
    const destPath = join(root, 'task-a')
    await writeMinimalRepoTree(mainPath)
    await mkdir(destPath, { recursive: true })

    await expect(
      materializeRepoManagedCheckout({
        mainPath,
        destPath,
        runCommand: async () => ({ code: 0, stdout: '', stderr: '' })
      })
    ).rejects.toThrow(`Derive destination already exists: ${destPath}`)
  })
})

describe('seedDerivedRepoProjectGitDirs', () => {
  it('clones by reference from the main working trees and publishes origin heads', async () => {
    const root = await tempRoot()
    const mainPath = join(root, 'main')
    const destPath = join(root, 'task-a')
    await mkdir(join(mainPath, '.repo'), { recursive: true })
    await mkdir(join(mainPath, 'bionic', '.git'), { recursive: true })
    await writeFile(join(mainPath, '.repo', 'project.list'), 'bionic\n')
    await mkdir(destPath, { recursive: true })

    const { gitExecFileAsync } = await import('../git/runner')
    await seedDerivedRepoProjectGitDirs({ mainPath, destPath })

    const destGit = join(destPath, '.repo', 'projects', 'bionic.git')
    const sourceGit = join(mainPath, 'bionic', '.git')
    const timeoutOptions = { cwd: destPath, timeout: 120_000 }
    expect(vi.mocked(gitExecFileAsync)).toHaveBeenCalledWith(
      ['clone', '--bare', '--no-local', '--reference', sourceGit, sourceGit, destGit],
      timeoutOptions
    )
    expect(
      vi.mocked(gitExecFileAsync).mock.calls.some((call) => call[0].includes('--shared'))
    ).toBe(false)
    expect(vi.mocked(gitExecFileAsync)).toHaveBeenCalledWith(
      ['--git-dir', destGit, 'config', 'core.bare', 'false'],
      timeoutOptions
    )
    expect(vi.mocked(gitExecFileAsync)).toHaveBeenCalledWith(
      [
        '--git-dir',
        destGit,
        'config',
        'remote.origin.fetch',
        '+refs/heads/*:refs/remotes/origin/*'
      ],
      timeoutOptions
    )
    expect(vi.mocked(gitExecFileAsync)).toHaveBeenCalledWith(
      [
        '--git-dir',
        destGit,
        'fetch',
        '--no-tags',
        sourceGit,
        '+refs/heads/*:refs/remotes/origin/*'
      ],
      timeoutOptions
    )
    expect(vi.mocked(gitExecFileAsync)).toHaveBeenCalledWith(
      [
        '--git-dir',
        destGit,
        'fetch',
        '--no-tags',
        sourceGit,
        '+refs/remotes/origin/*:refs/remotes/origin/*'
      ],
      timeoutOptions
    )
    expect(vi.mocked(gitExecFileAsync)).toHaveBeenCalledWith(
      ['--git-dir', destGit, 'update-ref', 'refs/remotes/origin/main', 'refs/heads/main'],
      timeoutOptions
    )
  })

  it('seeds from the object farm instead of a gitfile worktree', async () => {
    const root = await tempRoot()
    const mainPath = join(root, 'main')
    const destPath = join(root, 'task-a')
    const farm = join(mainPath, '.repo', 'projects', 'frameworks', 'base.git')
    await mkdir(farm, { recursive: true })
    await mkdir(join(mainPath, 'frameworks', 'base'), { recursive: true })
    await writeFile(
      join(mainPath, 'frameworks', 'base', '.git'),
      'gitdir: ../../.repo/projects/frameworks/base.git\n'
    )
    await writeFile(join(mainPath, '.repo', 'project.list'), 'frameworks/base\n')
    await mkdir(destPath, { recursive: true })

    const { gitExecFileAsync } = await import('../git/runner')
    await seedDerivedRepoProjectGitDirs({ mainPath, destPath })

    const destGit = join(destPath, '.repo', 'projects', 'frameworks', 'base.git')
    expect(vi.mocked(gitExecFileAsync)).toHaveBeenCalledWith(
      ['clone', '--bare', '--no-local', '--reference', farm, farm, destGit],
      { cwd: destPath, timeout: 120_000 }
    )
    expect(
      vi
        .mocked(gitExecFileAsync)
        .mock.calls.some((call) => call[0].includes(join(mainPath, 'frameworks', 'base', '.git')))
    ).toBe(false)
  })

  it('prefers the destination project.list after repo init', async () => {
    const root = await tempRoot()
    const mainPath = join(root, 'main')
    const destPath = join(root, 'task-a')
    await mkdir(join(mainPath, '.repo'), { recursive: true })
    await mkdir(join(mainPath, 'bionic', '.git'), { recursive: true })
    await mkdir(join(mainPath, 'art', '.git'), { recursive: true })
    await writeFile(join(mainPath, '.repo', 'project.list'), 'bionic\nart\n')
    await mkdir(join(destPath, '.repo'), { recursive: true })
    await writeFile(join(destPath, '.repo', 'project.list'), 'bionic\n')

    const { gitExecFileAsync } = await import('../git/runner')
    await seedDerivedRepoProjectGitDirs({ mainPath, destPath })

    const cloneCalls = vi
      .mocked(gitExecFileAsync)
      .mock.calls.filter((call) => call[0][0] === 'clone')
    expect(cloneCalls).toHaveLength(1)
    expect(cloneCalls[0]?.[0].at(-1)).toBe(join(destPath, '.repo', 'projects', 'bionic.git'))
  })

  it('skips projects without local objects and still seeds the rest', async () => {
    const root = await tempRoot()
    const mainPath = join(root, 'main')
    const destPath = join(root, 'task-a')
    await mkdir(join(mainPath, '.repo'), { recursive: true })
    await mkdir(join(mainPath, 'bionic', '.git'), { recursive: true })
    await writeFile(join(mainPath, '.repo', 'project.list'), 'missing\nbionic\n')
    await mkdir(destPath, { recursive: true })

    await expect(seedDerivedRepoProjectGitDirs({ mainPath, destPath })).resolves.toBe(1)
  })

  it('does not re-clone an existing destination gitdir but still publishes origin refs', async () => {
    const root = await tempRoot()
    const mainPath = join(root, 'main')
    const destPath = join(root, 'task-a')
    const destGit = join(destPath, '.repo', 'projects', 'bionic.git')
    await mkdir(join(mainPath, '.repo'), { recursive: true })
    await mkdir(join(mainPath, 'bionic', '.git'), { recursive: true })
    await writeFile(join(mainPath, '.repo', 'project.list'), 'bionic\n')
    await mkdir(destGit, { recursive: true })

    const { gitExecFileAsync } = await import('../git/runner')
    await seedDerivedRepoProjectGitDirs({ mainPath, destPath })

    expect(vi.mocked(gitExecFileAsync).mock.calls.some((call) => call[0][0] === 'clone')).toBe(
      false
    )
    expect(vi.mocked(gitExecFileAsync)).toHaveBeenCalledWith(
      ['--git-dir', destGit, 'update-ref', 'refs/remotes/origin/main', 'refs/heads/main'],
      { cwd: destPath, timeout: 120_000 }
    )
  })

  it('fails when the manifest lists projects but none have local git objects', async () => {
    const root = await tempRoot()
    const mainPath = join(root, 'main')
    const destPath = join(root, 'task-a')
    await mkdir(join(mainPath, '.repo'), { recursive: true })
    await writeFile(join(mainPath, '.repo', 'project.list'), 'bionic\n')
    await mkdir(destPath, { recursive: true })

    await expect(seedDerivedRepoProjectGitDirs({ mainPath, destPath })).rejects.toThrow(
      REPO_MANAGED_LOCAL_OBJECTS_MISSING
    )
  })
})

describe('deriveRepoManagedFolderWorkspace', () => {
  it('rejects SSH-backed repo groups', async () => {
    await expect(
      deriveRepoManagedFolderWorkspace({
        store: {
          getSettings: () => ({ nestWorkspaces: true, workspaceDir: '/tmp/workspaces' }),
          getProjectGroups: () => [repoManagedGroup('/src/aosp', { connectionId: 'ssh-1' })],
          createFolderWorkspace: () => {
            throw new Error('should not create')
          }
        },
        projectGroupId: 'group-1'
      })
    ).rejects.toThrow(REPO_MANAGED_DERIVE_SSH_UNSUPPORTED)
  })

  it('rejects groups that are not repo-managed checkouts', async () => {
    await expect(
      deriveRepoManagedFolderWorkspace({
        store: {
          getSettings: () => ({ nestWorkspaces: true, workspaceDir: '/tmp/workspaces' }),
          getProjectGroups: () => [repoManagedGroup('/src/app', { createdFrom: 'folder-scan' })],
          createFolderWorkspace: () => {
            throw new Error('should not create')
          }
        },
        projectGroupId: 'group-1'
      })
    ).rejects.toThrow(REPO_MANAGED_GROUP_REQUIRED)
  })

  it('rejects a missing project group', async () => {
    await expect(
      deriveRepoManagedFolderWorkspace({
        store: {
          getSettings: () => ({ nestWorkspaces: true, workspaceDir: '/tmp/workspaces' }),
          getProjectGroups: () => [],
          createFolderWorkspace: () => {
            throw new Error('should not create')
          }
        },
        projectGroupId: 'missing'
      })
    ).rejects.toThrow(REPO_MANAGED_GROUP_REQUIRED)
  })

  it('materializes a checkout then registers the folder workspace', async () => {
    const root = await tempRoot()
    const mainPath = join(root, 'main')
    const workspaceDir = join(root, 'workspaces')
    await writeMinimalRepoTree(mainPath)
    await mkdir(workspaceDir, { recursive: true })
    const phases: string[] = []
    const created: FolderWorkspace[] = []

    const workspace = await deriveRepoManagedFolderWorkspace({
      store: {
        getSettings: () => ({ nestWorkspaces: false, workspaceDir }),
        getProjectGroups: () => [repoManagedGroup(mainPath)],
        createFolderWorkspace: (input) => {
          const next = folderWorkspace({
            folderPath: input.folderPath ?? '',
            name: input.name ?? 'workspace',
            projectGroupId: input.projectGroupId
          })
          created.push(next)
          return next
        }
      },
      projectGroupId: 'group-1',
      name: 'task a',
      onPhase: (phase) => {
        phases.push(phase)
      },
      runCommand: async () => ({ code: 0, stdout: '', stderr: '' })
    })

    expect(phases).toEqual(['preparing', 'init', 'seed', 'sync', 'register'])
    expect(workspace.folderPath).toBe(join(workspaceDir, 'task-a'))
    expect(created).toHaveLength(1)
    await expect(stat(workspace.folderPath)).resolves.toBeTruthy()
  })
})
