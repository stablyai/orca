import { mkdtemp, readFile, stat, writeFile, mkdir, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  copyFolderWorkspaceForFork,
  resolveFolderWorkspaceForkDestinationPath
} from './folder-workspace-fork-copy'
import { SSH_FILESYSTEM_PROVIDER_UNAVAILABLE_MESSAGE } from './providers/ssh-filesystem-dispatch'

describe('folder workspace fork copy', () => {
  const cleanupPaths: string[] = []

  afterEach(async () => {
    await Promise.all(
      cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true }))
    )
  })

  it('copies local folders while respecting default and root ignore patterns', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-folder-fork-'))
    cleanupPaths.push(root)
    const source = join(root, 'source')
    const destination = join(root, 'destination')

    await mkdir(join(source, 'src'), { recursive: true })
    await mkdir(join(source, 'node_modules', 'pkg'), { recursive: true })
    await mkdir(join(source, 'cache'), { recursive: true })
    await writeFile(join(source, 'src', 'app.ts'), 'export const value = 1')
    await writeFile(join(source, 'node_modules', 'pkg', 'index.js'), 'generated')
    await writeFile(join(source, 'cache', 'trace.log'), 'generated')
    await writeFile(join(source, '.orcaignore'), 'cache/\n')

    await copyFolderWorkspaceForFork(
      { sourcePath: source, destinationPath: destination },
      { getSshFilesystemProvider: () => undefined }
    )

    await expect(readFile(join(destination, 'src', 'app.ts'), 'utf8')).resolves.toBe(
      'export const value = 1'
    )
    await expect(stat(join(destination, 'node_modules'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(join(destination, 'cache'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('copies remote folders through the SSH filesystem provider', async () => {
    const provider = {
      readFile: vi.fn(async (filePath: string) => {
        if (filePath.endsWith('/.orcaignore')) {
          return { content: 'cache/\n', isBinary: false }
        }
        throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      }),
      createDir: vi.fn().mockResolvedValue(undefined),
      copy: vi.fn().mockResolvedValue(undefined)
    }

    const result = await copyFolderWorkspaceForFork(
      {
        sourcePath: '/home/dev/repo',
        destinationPath: '/home/dev/repo-fork',
        connectionId: 'ssh-1'
      },
      { getSshFilesystemProvider: () => provider as never }
    )

    expect(result.destinationPath).toBe('/home/dev/repo-fork')
    expect(provider.readFile).toHaveBeenCalledWith('/home/dev/repo/.orcaignore')
    expect(provider.createDir).toHaveBeenCalledWith('/home/dev')
    expect(provider.copy).toHaveBeenCalledWith('/home/dev/repo', '/home/dev/repo-fork', {
      ignorePatterns: expect.arrayContaining(['cache/'])
    })
  })

  it('rejects remote copies when the SSH filesystem provider is unavailable', async () => {
    await expect(
      copyFolderWorkspaceForFork(
        {
          sourcePath: '/home/dev/repo',
          destinationPath: '/home/dev/repo-fork',
          connectionId: 'ssh-1'
        },
        { getSshFilesystemProvider: () => undefined }
      )
    ).rejects.toThrow(SSH_FILESYSTEM_PROVIDER_UNAVAILABLE_MESSAGE)
  })

  it('resolves SSH folder fork destinations on the remote host', () => {
    const repo = {
      id: 'repo-1',
      path: '/home/dev/repo',
      displayName: 'Repo',
      badgeColor: 'blue',
      addedAt: 1,
      kind: 'folder' as const,
      connectionId: 'ssh-1'
    }

    expect(
      resolveFolderWorkspaceForkDestinationPath({
        repo,
        settings: { workspaceDir: 'C:\\Users\\dev\\orca\\workspaces', nestWorkspaces: false },
        name: 'Feature Branch'
      })
    ).toBe('/home/dev/Feature-Branch')

    expect(
      resolveFolderWorkspaceForkDestinationPath({
        repo: { ...repo, worktreeBasePath: '/srv/orca-workspaces' },
        settings: { workspaceDir: 'C:\\Users\\dev\\orca\\workspaces', nestWorkspaces: false },
        name: 'Feature Branch'
      })
    ).toBe('/srv/orca-workspaces/Feature-Branch')
  })
})
