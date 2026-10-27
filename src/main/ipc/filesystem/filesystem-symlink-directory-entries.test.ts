import { mkdtemp, mkdir, symlink, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { classifyFilesystemDirectoryEntries } from './filesystem-symlink-directory-entries'

it('keeps passive listings free of target probes and classifies opted-in authorized targets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-directory-links-'))
  try {
    await mkdir(join(root, 'inside'))
    const linkType = process.platform === 'win32' ? 'junction' : 'dir'
    await symlink(join(root, 'inside'), join(root, 'folder-link'), linkType)
    await symlink(join(root, 'missing'), join(root, 'broken-link'), linkType)
    await symlink(root, join(root, 'denied-link'), linkType)
    const entries = await readdir(root, { withFileTypes: true })
    const authorize = vi.fn(async (path: string) => {
      if (path.endsWith('denied-link')) {
        throw new Error('unauthorized')
      }
      return path
    })
    const passive = await classifyFilesystemDirectoryEntries(root, entries, false, authorize)
    expect(authorize).not.toHaveBeenCalled()
    expect(passive.find((entry) => entry.name === 'folder-link')).toMatchObject({
      isDirectory: false,
      isSymlink: true
    })
    const followed = await classifyFilesystemDirectoryEntries(root, entries, true, authorize)
    expect(followed.find((entry) => entry.name === 'folder-link')).toMatchObject({
      isDirectory: true,
      isSymlink: true
    })
    expect(followed.find((entry) => entry.name === 'broken-link')).toMatchObject({
      isDirectory: false,
      isSymlink: true
    })
    expect(followed.find((entry) => entry.name === 'denied-link')).toMatchObject({
      isDirectory: false,
      isSymlink: true
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
