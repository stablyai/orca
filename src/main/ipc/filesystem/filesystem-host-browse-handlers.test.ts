import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostDirectoryListing } from '../../../shared/filesystem-entry-types'
import type { Store } from '../../persistence'
import { isPathAllowed, resolveAuthorizedPath } from './filesystem-auth'
import {
  registerFilesystemHostBrowseHandlers,
  resolveHostBrowseEntry
} from './filesystem-host-browse-handlers'

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, args: unknown) => unknown>()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, args: unknown) => unknown) =>
      handlers.set(channel, handler)
  }
}))

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: allowed-root lookups read only these four accessors.
const store = {
  getRepos: () => [],
  getProjectGroups: () => [],
  getFolderWorkspaces: () => [],
  getSettings: () => ({})
} as unknown as Store

describe('host browse handlers', () => {
  let root: string

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'orca-host-browse-')))
    await mkdir(join(root, 'outside', 'nested'), { recursive: true })
    await writeFile(join(root, 'outside', 'notes.txt'), 'hi')
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
    await expect(isPathAllowed(outside, store)).resolves.toBe(false)
    await expect(isPathAllowed(join(outside, 'nested', 'x'), store)).resolves.toBe(false)
    await expect(resolveAuthorizedPath(join(outside, 'nested'), store)).rejects.toThrow(
      /Access denied/
    )
  })

  it('classifies a regular file outside the workspace without granting it', async () => {
    const file = join(root, 'outside', 'notes.txt')
    const resolution = await resolveHostBrowseEntry(file)

    expect(resolution).toEqual({ kind: 'file', realPath: file, workspaceRelativePath: null })
    await expect(isPathAllowed(file, store)).resolves.toBe(false)
    await expect(isPathAllowed(join(root, 'outside'), store)).resolves.toBe(false)
    await expect(isPathAllowed(join(root, 'outside', 'nested'), store)).resolves.toBe(false)
  })

  it('classifies a symlink to a directory as a directory and grants nothing', async () => {
    const target = join(root, 'outside', 'nested')
    const link = join(root, 'dir-link')
    await symlink(target, link, 'dir')

    const resolution = await resolveHostBrowseEntry(link)

    expect(resolution).toEqual({ kind: 'directory', realPath: target, workspaceRelativePath: null })
    await expect(isPathAllowed(join(target, 'anything'), store)).resolves.toBe(false)
    await expect(isPathAllowed(join(link, 'anything'), store)).resolves.toBe(false)
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

  it('rejects relative and null-byte paths, locally and over SSH', async () => {
    await expect(resolveHostBrowseEntry('outside/notes.txt'), 'relative').rejects.toThrow(
      /absolute/
    )
    await expect(resolveHostBrowseEntry(`${root}\0x`), 'local NUL').rejects.toThrow(/null bytes/)
    await expect(
      resolveHostBrowseEntry('/home/allen\0x', 'ssh-1'),
      'null-byte SSH path'
    ).rejects.toThrow(/null bytes/)
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
    await expect(isPathAllowed(outsideLink, store)).resolves.toBe(false)
  })
})
