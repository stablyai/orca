import { lstat, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import type * as Os from 'node:os'
import { basename, dirname, join, parse, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Store } from '../../persistence'

const { mockedHomedir } = vi.hoisted(() => ({
  mockedHomedir: { value: null as string | null }
}))

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof Os>()
  return {
    ...actual,
    homedir: () => mockedHomedir.value ?? actual.homedir()
  }
})

import {
  grantExternalDirectoryFromRenderer,
  grantExternalFileFromRenderer,
  isPathAllowed
} from '../filesystem-auth'

function emptyStore(): Store {
  return {
    getRepos: () => [],
    getProjectGroups: () => [],
    getFolderWorkspaces: () => [],
    getSettings: () => ({})
  } as unknown as Store
}

function flipAsciiLetterCase(input: string): string {
  let flipped = ''
  for (const character of input) {
    if (character >= 'a' && character <= 'z') {
      flipped += character.toUpperCase()
    } else if (character >= 'A' && character <= 'Z') {
      flipped += character.toLowerCase()
    } else {
      flipped += character
    }
  }
  return flipped
}

describe('renderer external path grants', () => {
  const tempDirs: string[] = []

  afterEach(async () => {
    mockedHomedir.value = null
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  async function makeTempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'orca-allowlist-'))
    tempDirs.push(dir)
    return dir
  }

  it('does not grant a missing probe path through the renderer file grant', async () => {
    const probe = join(tmpdir(), 'orca-allowlist-probe')
    await expect(grantExternalFileFromRenderer(probe)).rejects.toThrow(
      `File not found: ${resolve(probe)}`
    )
    expect(isPathAllowed(probe, emptyStore())).toBe(false)
  })

  it('rejects granting the home directory and leaves it denied', async () => {
    const home = homedir()
    await expect(grantExternalFileFromRenderer(home)).rejects.toThrow()
    await expect(grantExternalDirectoryFromRenderer(home)).rejects.toThrow()
    expect(isPathAllowed(home, emptyStore())).toBe(false)
  })

  it('rejects granting the volume root', async () => {
    const volumeRoot = parse(process.cwd()).root
    await expect(grantExternalFileFromRenderer(volumeRoot)).rejects.toThrow()
    await expect(grantExternalDirectoryFromRenderer(volumeRoot)).rejects.toThrow()
    expect(isPathAllowed(volumeRoot, emptyStore())).toBe(false)
  })

  it('grants a real temp file without allowing a sibling in the same directory', async () => {
    const dir = await makeTempDir()
    const filePath = join(dir, 'leaf.txt')
    const siblingPath = join(dir, 'sibling.txt')
    await writeFile(filePath, 'leaf')
    await writeFile(siblingPath, 'sibling')

    await grantExternalFileFromRenderer(filePath)

    const store = emptyStore()
    expect(isPathAllowed(filePath, store)).toBe(true)
    expect(isPathAllowed(siblingPath, store)).toBe(false)
    expect(isPathAllowed(dir, store)).toBe(false)
  })

  it('rejects granting a temp directory so descendants stay denied', async () => {
    const dir = await makeTempDir()
    const nested = join(dir, 'nested.txt')
    await writeFile(nested, 'nested')

    await expect(grantExternalFileFromRenderer(dir)).rejects.toThrow(
      `Cannot open a directory: ${resolve(dir)}`
    )
    expect(isPathAllowed(dir, emptyStore())).toBe(false)
    expect(isPathAllowed(nested, emptyStore())).toBe(false)
  })

  it('rejects empty, NUL, and relative renderer grant paths', async () => {
    await expect(grantExternalFileFromRenderer('')).rejects.toThrow()
    await expect(grantExternalFileFromRenderer(`bad\0path`)).rejects.toThrow()
    await expect(grantExternalFileFromRenderer('relative/file.txt')).rejects.toThrow()
    expect(isPathAllowed(resolve('relative/file.txt'), emptyStore())).toBe(false)
  })

  it('grants a real temp directory that is not homedir or volume root', async () => {
    const dir = await makeTempDir()
    const nested = join(dir, 'nested.txt')
    await writeFile(nested, 'nested')

    await grantExternalDirectoryFromRenderer(dir)

    const store = emptyStore()
    expect(isPathAllowed(dir, store)).toBe(true)
    expect(isPathAllowed(nested, store)).toBe(true)
  })

  it('rejects a case-variant home directory and does not authorize it', async () => {
    const home = await makeTempDir()
    mockedHomedir.value = home
    if (homedir() !== home) {
      throw new Error(
        'node:os homedir mock is not active; refusing to probe the real home directory'
      )
    }
    const variant = flipAsciiLetterCase(home)
    if (variant === home) {
      return
    }
    try {
      await lstat(variant)
    } catch {
      // Case-sensitive filesystem: the macOS case-variant bypass cannot exist here.
      return
    }

    await expect(grantExternalDirectoryFromRenderer(variant)).rejects.toThrow()
    await expect(grantExternalFileFromRenderer(variant)).rejects.toThrow()

    const store = emptyStore()
    expect(isPathAllowed(home, store)).toBe(false)
    expect(isPathAllowed(variant, store)).toBe(false)
    expect(isPathAllowed(join(home, 'secret'), store)).toBe(false)
  })

  it('rejects a home directory reached through a symlinked parent and does not authorize it', async () => {
    const home = await makeTempDir()
    mockedHomedir.value = home
    if (homedir() !== home) {
      throw new Error(
        'node:os homedir mock is not active; refusing to probe the real home directory'
      )
    }
    const aliasRoot = await makeTempDir()
    const parentLink = join(aliasRoot, 'home-parent')
    try {
      await symlink(dirname(home), parentLink, 'dir')
    } catch {
      try {
        await symlink(dirname(home), parentLink, 'junction')
      } catch {
        // Windows without symlink privilege cannot construct this parent-alias bypass.
        return
      }
    }
    const aliasedHome = join(parentLink, basename(home))

    await expect(grantExternalDirectoryFromRenderer(aliasedHome)).rejects.toThrow()
    await expect(grantExternalFileFromRenderer(aliasedHome)).rejects.toThrow()

    const store = emptyStore()
    expect(isPathAllowed(home, store)).toBe(false)
    expect(isPathAllowed(aliasedHome, store)).toBe(false)
    expect(isPathAllowed(join(home, 'secret'), store)).toBe(false)
  })
})
