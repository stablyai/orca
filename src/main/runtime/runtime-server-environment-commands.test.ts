import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RuntimeServerEnvironmentCommands } from './runtime-server-environment-commands'

const dirLinkType = process.platform === 'win32' ? 'junction' : 'dir'

describe('RuntimeServerEnvironmentCommands.browseDirectory', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-server-browse-symlink-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it.skipIf(process.platform === 'win32')(
    'lists a symlinked directory as a directory and keeps broken links and loops as files',
    async () => {
      await mkdir(join(root, 'real-dir'))
      await writeFile(join(root, 'real-file.txt'), 'x\n')
      await symlink(join(root, 'real-dir'), join(root, 'linked-dir'), dirLinkType)
      await symlink(join(root, 'real-file.txt'), join(root, 'linked-file'))
      await symlink(join(root, 'missing-target'), join(root, 'broken-link'))
      await symlink(join(root, 'loop-b'), join(root, 'loop-a'))
      await symlink(join(root, 'loop-a'), join(root, 'loop-b'))

      const result = await new RuntimeServerEnvironmentCommands().browseDirectory(root)

      expect(result.entries).toEqual([
        { name: 'linked-dir', isDirectory: true, isSymlink: true },
        { name: 'real-dir', isDirectory: true, isSymlink: false },
        { name: 'broken-link', isDirectory: false, isSymlink: true },
        { name: 'linked-file', isDirectory: false, isSymlink: true },
        { name: 'loop-a', isDirectory: false, isSymlink: true },
        { name: 'loop-b', isDirectory: false, isSymlink: true },
        { name: 'real-file.txt', isDirectory: false, isSymlink: false }
      ])
    }
  )

  it('navigates into a symlinked directory', async () => {
    await mkdir(join(root, 'real-dir', 'project'), { recursive: true })
    await symlink(join(root, 'real-dir'), join(root, 'linked-dir'), dirLinkType)

    const result = await new RuntimeServerEnvironmentCommands().browseDirectory(
      join(root, 'linked-dir')
    )

    expect(result.resolvedPath).toBe(join(root, 'linked-dir'))
    expect(result.entries).toEqual([{ name: 'project', isDirectory: true, isSymlink: false }])
  })
})
