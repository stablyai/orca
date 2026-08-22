import { mkdir, mkdtemp, writeFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProjectGroup } from '../../shared/project-group-types'
import {
  REPO_MANAGED_DERIVE_SSH_UNSUPPORTED,
  deriveRepoManagedFolderWorkspace,
  materializeRepoManagedCheckout
} from './repo-managed-derive'

vi.mock('../git/runner', () => ({
  gitExecFileAsync: vi.fn(async (args: string[]) => {
    const keyIndex = args.lastIndexOf('--get')
    const key = keyIndex >= 0 ? args[keyIndex + 1] : ''
    if (key === 'remote.origin.url') {
      return { stdout: 'https://example.com/manifest.git\n', stderr: '' }
    }
    if (args.includes('--abbrev-ref')) {
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
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
  tempDirs = []
})

describe('materializeRepoManagedCheckout', () => {
  it('runs repo init then sync and keeps the destination on success', async () => {
    const root = await tempRoot()
    const mainPath = join(root, 'main')
    const destPath = join(root, 'task-a')
    await mkdir(join(mainPath, '.repo', 'repo'), { recursive: true })
    await writeFile(join(mainPath, '.repo', 'repo', 'repo'), '#!/bin/sh\n')
    await writeFile(join(mainPath, '.repo', 'manifest.xml'), '<manifest />\n')
    const commands: string[][] = []

    await materializeRepoManagedCheckout({
      mainPath,
      destPath,
      runCommand: async ({ args }) => {
        commands.push([...args])
        return { code: 0, stdout: '', stderr: '' }
      }
    })

    expect(commands[0]?.[0]).toBe('init')
    expect(commands[0]).toContain('--reference')
    expect(commands[1]).toEqual(['sync', '--local-only', '--current-branch', '--fail-fast'])
    await expect(stat(destPath)).resolves.toBeTruthy()
  })

  it('deletes the destination when repo sync fails', async () => {
    const root = await tempRoot()
    const mainPath = join(root, 'main')
    const destPath = join(root, 'task-a')
    await mkdir(join(mainPath, '.repo', 'repo'), { recursive: true })
    await writeFile(join(mainPath, '.repo', 'repo', 'repo'), '#!/bin/sh\n')
    await writeFile(join(mainPath, '.repo', 'manifest.xml'), '<manifest />\n')

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
})

describe('deriveRepoManagedFolderWorkspace', () => {
  it('rejects SSH-backed repo groups', async () => {
    const group: ProjectGroup = {
      id: 'group-1',
      name: 'AOSP',
      parentPath: '/src/aosp',
      connectionId: 'ssh-1',
      parentGroupId: null,
      createdFrom: 'repo-managed',
      tabOrder: 0,
      isCollapsed: false,
      color: null,
      createdAt: 1,
      updatedAt: 1
    }
    await expect(
      deriveRepoManagedFolderWorkspace({
        store: {
          getSettings: () => ({ nestWorkspaces: true, workspaceDir: '/tmp/workspaces' }),
          getProjectGroups: () => [group],
          createFolderWorkspace: () => {
            throw new Error('should not create')
          }
        },
        projectGroupId: 'group-1'
      })
    ).rejects.toThrow(REPO_MANAGED_DERIVE_SSH_UNSUPPORTED)
  })
})
