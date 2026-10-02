import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostDirectoryListing } from '../../../shared/filesystem-entry-types'
import type { Store } from '../../persistence'
import { isPathAllowed, resolveAuthorizedPath } from '../filesystem-auth'
import {
  registerFilesystemHostBrowseHandlers,
  resolveHostBrowseEntry
} from './filesystem-host-browse-handlers'

const { requireSshFilesystemProviderMock, handlers } = vi.hoisted(() => ({
  requireSshFilesystemProviderMock: vi.fn(),
  handlers: new Map<string, (event: unknown, args: unknown) => unknown>()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, args: unknown) => unknown) =>
      handlers.set(channel, handler)
  }
}))

vi.mock('../../providers/ssh-filesystem-dispatch', () => ({
  requireSshFilesystemProvider: requireSshFilesystemProviderMock
}))

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: allowed-root lookups read only these four accessors.
const store = {
  getRepos: () => [],
  getProjectGroups: () => [],
  getFolderWorkspaces: () => [],
  getSettings: () => ({})
} as unknown as Store

function sshProvider(stat = vi.fn(), realpath = (path: string): string => path) {
  const provider = { realpath: vi.fn(async (path: string) => realpath(path)), stat }
  requireSshFilesystemProviderMock.mockReturnValue(provider)
  return provider
}

describe('host browse handlers', () => {
  let root: string

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'orca-host-browse-')))
    await mkdir(join(root, 'outside', 'nested'), { recursive: true })
    await writeFile(join(root, 'outside', 'notes.txt'), 'hi')
    requireSshFilesystemProviderMock.mockReset()
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('lists a directory outside allowed roots without granting access to it', async () => {
    registerFilesystemHostBrowseHandlers()
    const outside = join(root, 'outside')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: fs:browseHostDir resolves to a HostDirectoryListing.
    const listing = (await handlers.get('fs:browseHostDir')?.(null, {
      dirPath: outside
    })) as HostDirectoryListing

    expect(listing.resolvedPath).toBe(outside)
    expect(listing.entries.map((entry) => entry.name).sort()).toEqual(['nested', 'notes.txt'])
    expect(isPathAllowed(outside, store)).toBe(false)
    expect(isPathAllowed(join(outside, 'nested', 'x'), store)).toBe(false)
    await expect(resolveAuthorizedPath(join(outside, 'nested'), store)).rejects.toThrow(
      /Access denied/
    )
  })

  it('grants a regular file only, never its parent directory', async () => {
    const file = join(root, 'outside', 'notes.txt')
    const resolution = await resolveHostBrowseEntry(file)

    expect(resolution).toEqual({ kind: 'file', realPath: file, workspaceRelativePath: null })
    expect(isPathAllowed(file, store)).toBe(true)
    expect(isPathAllowed(join(root, 'outside'), store)).toBe(false)
    expect(isPathAllowed(join(root, 'outside', 'nested'), store)).toBe(false)
  })

  it('classifies a symlink to a directory as a directory and grants nothing', async () => {
    const target = join(root, 'outside', 'nested')
    const link = join(root, 'dir-link')
    await symlink(target, link, 'dir')

    const resolution = await resolveHostBrowseEntry(link)

    expect(resolution).toEqual({ kind: 'directory', realPath: target, workspaceRelativePath: null })
    expect(isPathAllowed(join(target, 'anything'), store)).toBe(false)
    expect(isPathAllowed(join(link, 'anything'), store)).toBe(false)
  })

  it('reports the canonical path of a symlinked file for worktree ownership checks', async () => {
    const target = join(root, 'outside', 'notes.txt')
    const link = join(root, 'file-link')
    await symlink(target, link, 'file')

    await expect(resolveHostBrowseEntry(link)).resolves.toEqual({
      kind: 'file',
      realPath: target,
      workspaceRelativePath: null
    })
  })

  it('rejects relative and null-byte paths, locally and before SSH paths reach the relay', async () => {
    const provider = sshProvider()

    await expect(resolveHostBrowseEntry('outside/notes.txt'), 'relative').rejects.toThrow(
      /absolute/
    )
    await expect(resolveHostBrowseEntry(`${root}\0x`), 'local NUL').rejects.toThrow(/null bytes/)
    await expect(
      resolveHostBrowseEntry('/home/allen\0x', 'ssh-1'),
      'null-byte SSH path'
    ).rejects.toThrow(/null bytes/)
    expect(provider.realpath, 'null-byte SSH path never reaches the relay').not.toHaveBeenCalled()
  })

  it('classifies SSH entries through the provider realpath without local grants', async () => {
    const provider = sshProvider(
      vi.fn().mockResolvedValue({ type: 'directory', size: 0, mtime: 0 }),
      (path) => (path === '/home/allen/link' ? '/home/allen/codes/repo/src' : path)
    )

    await expect(
      resolveHostBrowseEntry('/home/allen/link', 'ssh-1', '/home/allen/codes/repo')
    ).resolves.toEqual({
      kind: 'directory',
      realPath: '/home/allen/codes/repo/src',
      workspaceRelativePath: 'src'
    })
    expect(requireSshFilesystemProviderMock).toHaveBeenCalledWith('ssh-1')
    expect(provider.stat).toHaveBeenCalledWith('/home/allen/codes/repo/src')
    expect(provider.realpath).toHaveBeenCalledWith('/home/allen/codes/repo')
    expect(isPathAllowed('/home/allen/link', store)).toBe(false)
  })

  it('maps SSH file stats to file and anything else to unsupported', async () => {
    sshProvider(
      vi
        .fn()
        .mockResolvedValueOnce({ type: 'file', size: 1, mtime: 0 })
        .mockResolvedValueOnce({ type: 'symlink', size: 1, mtime: 0 })
    )

    await expect(resolveHostBrowseEntry('/etc/hosts', 'ssh-1')).resolves.toEqual({
      kind: 'file',
      realPath: '/etc/hosts',
      workspaceRelativePath: null
    })
    await expect(resolveHostBrowseEntry('/dev/weird', 'ssh-1')).resolves.toEqual({
      kind: 'unsupported',
      realPath: '/dev/weird',
      workspaceRelativePath: null
    })
  })

  it('resolves workspace ownership against the canonical workspace root', async () => {
    const realWorkspace = join(root, 'real-workspace')
    await mkdir(join(realWorkspace, 'src'), { recursive: true })
    await writeFile(join(realWorkspace, 'src', 'a.ts'), 'x')
    const workspaceAlias = join(root, 'workspace-alias')
    await symlink(realWorkspace, workspaceAlias, 'dir')
    const outsideLink = join(root, 'outside', 'a-link.ts')
    await symlink(join(realWorkspace, 'src', 'a.ts'), outsideLink, 'file')

    const resolution = await resolveHostBrowseEntry(outsideLink, undefined, workspaceAlias)

    expect(resolution).toEqual({
      kind: 'file',
      realPath: join(realWorkspace, 'src', 'a.ts'),
      workspaceRelativePath: 'src/a.ts'
    })
    // Why: workspace files are reached through allowed roots; no external grant is added.
    expect(isPathAllowed(outsideLink, store)).toBe(false)
  })

  it('treats an SSH file as outside the workspace when the workspace realpath fails', async () => {
    sshProvider(vi.fn().mockResolvedValue({ type: 'file', size: 1, mtime: 0 }), (path) => {
      if (path === '/home/allen/codes') {
        throw new Error('connection lost')
      }
      return path
    })

    await expect(
      resolveHostBrowseEntry('/home/allen/codes/src/a.ts', 'ssh-1', '/home/allen/codes')
    ).resolves.toEqual({
      kind: 'file',
      realPath: '/home/allen/codes/src/a.ts',
      workspaceRelativePath: null
    })
  })
})
