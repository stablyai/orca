import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isPathInsideOrEqual } from '../../shared/cross-platform-path'
import { RuntimeServerEnvironmentCommands } from './runtime-server-environment-commands'

describe('RuntimeServerEnvironmentCommands.browseDirectory', () => {
  const commands = new RuntimeServerEnvironmentCommands()

  it('lists the home directory', async () => {
    const result = await commands.browseDirectory('~')
    expect(result.resolvedPath).toBe(resolve(homedir()))
    expect(result.pathFlavor).toBe(process.platform === 'win32' ? 'win32' : 'posix')
    expect(Array.isArray(result.entries)).toBe(true)
  })

  it('lists a descendant of the home directory', async () => {
    const tempRoot = await mkdtemp(join(homedir(), 'orca-runtime-browse-'))
    try {
      await mkdir(join(tempRoot, 'zeta'))
      await mkdir(join(tempRoot, 'alpha'))
      await writeFile(join(tempRoot, 'readme.md'), '# Readme\n')

      const result = await commands.browseDirectory(tempRoot)

      expect(result.resolvedPath).toBe(resolve(tempRoot))
      expect(result.entries).toEqual([
        { name: 'alpha', isDirectory: true, isSymlink: false },
        { name: 'zeta', isDirectory: true, isSymlink: false },
        { name: 'readme.md', isDirectory: false, isSymlink: false }
      ])
    } finally {
      await rm(tempRoot, { recursive: true, force: true })
    }
  })

  it('rejects a null byte before resolving', async () => {
    await expect(commands.browseDirectory('/tmp\0/etc')).rejects.toThrow(
      'Path cannot contain null bytes'
    )
  })

  it('does not readdir an arbitrary absolute path outside home', async () => {
    const outsideHome = process.platform === 'win32' ? 'C:\\Windows' : '/etc'
    await expect(commands.browseDirectory(outsideHome)).rejects.toThrow(
      'Directory browsing is limited to the home directory.'
    )
  })

  it('does not readdir a sibling of the home directory', async () => {
    const sibling = resolve(homedir(), '..', 'orca-rpc-gate-deny')
    await expect(commands.browseDirectory(sibling)).rejects.toThrow(
      'Directory browsing is limited to the home directory.'
    )
  })

  it('does not treat a temp dir outside home as allowed', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'orca-runtime-browse-outside-'))
    try {
      if (isPathInsideOrEqual(homedir(), tempRoot)) {
        return
      }
      await expect(commands.browseDirectory(tempRoot)).rejects.toThrow(
        'Directory browsing is limited to the home directory.'
      )
    } finally {
      await rm(tempRoot, { recursive: true, force: true })
    }
  })

  it('rejects a symlink from inside home that points outside home', async () => {
    const outsideHome =
      process.platform === 'win32' ? (process.env.SystemRoot ?? 'C:\\Windows') : '/etc'
    expect(isPathInsideOrEqual(homedir(), outsideHome)).toBe(false)

    const tempRoot = await mkdtemp(join(homedir(), 'orca-runtime-browse-link-'))
    const linkPath = join(tempRoot, 'outside-link')
    try {
      await symlink(outsideHome, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
      await expect(commands.browseDirectory(linkPath)).rejects.toThrow(
        'Directory browsing is limited to the home directory.'
      )
    } finally {
      await rm(tempRoot, { recursive: true, force: true })
    }
  })
})
