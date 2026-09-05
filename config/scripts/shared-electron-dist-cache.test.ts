import type { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  shareElectronDistFromCache,
  hasAdoptedSharedElectronDist,
  isUsableElectronDist,
  publishSharedElectronDist,
  recordAdoptedSharedElectronDist,
  resolveSharedElectronDistEntry
} from './shared-electron-dist-cache.mjs'
import { makeTreeReadOnly } from './space-sharing-copy.mjs'

const VERSION = '43.4.1'
const PLATFORM_PATH = path.join('Electron.app', 'Contents', 'MacOS', 'Electron')
const identity = { version: VERSION, platformPath: PLATFORM_PATH }
const roots: string[] = []

afterEach(() => {
  while (roots.length > 0) {
    rmSync(roots.pop()!, { recursive: true, force: true })
  }
})

function makeRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'orca-shared-electron-'))
  roots.push(root)
  return root
}

function writeDist(distPath: string, version = VERSION): string {
  mkdirSync(path.join(distPath, path.dirname(PLATFORM_PATH)), { recursive: true })
  writeFileSync(path.join(distPath, 'version'), `v${version}\n`)
  writeFileSync(path.join(distPath, PLATFORM_PATH), 'electron')
  return distPath
}

function makeEntry(root: string, entryName = `${VERSION}-darwin-arm64`) {
  const cacheRoot = path.join(root, 'cache')
  return {
    cacheRoot,
    entryPath: path.join(cacheRoot, entryName),
    markerPath: path.join(root, '.orca-shared-dist')
  }
}

const baseOptions = {
  repoRoot: '/repo',
  electronPackageDir: '/repo/node_modules/electron',
  version: VERSION,
  targetPlatform: 'darwin',
  targetArch: 'arm64',
  hostPlatform: 'darwin' as const,
  env: {} as NodeJS.ProcessEnv,
  execFile: (() => '/repo/.git\n') as unknown as typeof execFileSync
}

describe('resolveSharedElectronDistEntry', () => {
  it('keys the entry by version, platform, and arch under the git common dir', () => {
    const entry = resolveSharedElectronDistEntry(baseOptions)
    expect(entry?.cacheRoot).toBe(path.join('/repo/.git', 'orca-cache', 'electron'))
    expect(entry?.entryPath).toBe(
      path.join('/repo/.git', 'orca-cache', 'electron', '43.4.1-darwin-arm64')
    )
    expect(entry?.markerPath).toBe(path.join('/repo/node_modules/electron', '.orca-shared-dist'))
  })

  it('offers an entry on every platform a worktree is developed on', () => {
    for (const hostPlatform of ['darwin', 'linux', 'win32']) {
      expect(resolveSharedElectronDistEntry({ ...baseOptions, hostPlatform })).not.toBeNull()
    }
  })

  it('declines on CI, where every job gets a fresh checkout', () => {
    expect(resolveSharedElectronDistEntry({ ...baseOptions, env: { CI: '1' } })).toBeNull()
    expect(resolveSharedElectronDistEntry({ ...baseOptions, env: { CI: 'true' } })).toBeNull()
    expect(resolveSharedElectronDistEntry({ ...baseOptions, env: { CI: 'false' } })).not.toBeNull()
  })

  it('declines outside a Git worktree so folder workspaces install normally', () => {
    const execFile = (() => {
      throw new Error('not a git repository')
    }) as unknown as typeof execFileSync
    expect(resolveSharedElectronDistEntry({ ...baseOptions, execFile })).toBeNull()
  })

  it('declines an identity that would not be a single safe path segment', () => {
    expect(resolveSharedElectronDistEntry({ ...baseOptions, targetArch: '../escape' })).toBeNull()
    expect(resolveSharedElectronDistEntry({ ...baseOptions, targetPlatform: 'dar/win' })).toBeNull()
    expect(resolveSharedElectronDistEntry({ ...baseOptions, version: '' })).toBeNull()
  })
})

describe('isUsableElectronDist', () => {
  it('accepts a complete dist and tolerates the leading v in the version file', () => {
    const root = makeRoot()
    expect(isUsableElectronDist(writeDist(path.join(root, 'dist')), VERSION, PLATFORM_PATH)).toBe(
      true
    )
  })

  it('rejects a version mismatch, a missing executable, and a missing directory', () => {
    const root = makeRoot()
    expect(
      isUsableElectronDist(writeDist(path.join(root, 'a'), '40.0.0'), VERSION, PLATFORM_PATH)
    ).toBe(false)
    const partial = path.join(root, 'b')
    mkdirSync(partial, { recursive: true })
    writeFileSync(path.join(partial, 'version'), `v${VERSION}`)
    expect(isUsableElectronDist(partial, VERSION, PLATFORM_PATH)).toBe(false)
    expect(isUsableElectronDist(path.join(root, 'missing'), VERSION, PLATFORM_PATH)).toBe(false)
  })

  it('rejects a symlink so a redirected entry is never treated as cache content', () => {
    const root = makeRoot()
    writeDist(path.join(root, 'real'))
    symlinkSync(path.join(root, 'real'), path.join(root, 'link'), 'dir')
    expect(isUsableElectronDist(path.join(root, 'link'), VERSION, PLATFORM_PATH)).toBe(false)
  })
})

describe('publishSharedElectronDist', () => {
  it('publishes through a staging directory and an atomic rename', () => {
    const root = makeRoot()
    const entry = makeEntry(root)
    const dist = writeDist(path.join(root, 'dist'))
    const share = vi.fn((source: string, destination: string) => {
      expect(path.basename(destination)).toMatch(/^43\.4\.1-darwin-arm64\.staging-/)
      writeDist(destination)
      expect(source).toBe(dist)
    })
    expect(publishSharedElectronDist(dist, entry, { share, ...identity })).toBe(true)
    expect(isUsableElectronDist(entry.entryPath, VERSION, PLATFORM_PATH)).toBe(true)
    expect(readdirSync(entry.cacheRoot)).toEqual([path.basename(entry.entryPath)])
  })

  it('publishes the entry read-only, before it is reachable under its final name', () => {
    const root = makeRoot()
    const entry = makeEntry(root)
    const dist = writeDist(path.join(root, 'dist'))
    const protectedPaths: string[] = []
    const share = (source: string, destination: string) => {
      writeDist(destination)
      expect(source).toBe(dist)
    }
    const protect = (target: string) => {
      // Why order matters: a reader can clone the entry the instant the rename lands.
      expect(existsSync(entry.entryPath)).toBe(false)
      protectedPaths.push(target)
      makeTreeReadOnly(target)
    }
    expect(publishSharedElectronDist(dist, entry, { share, protect, ...identity })).toBe(true)
    expect(protectedPaths).toHaveLength(1)
    expect(statSync(path.join(entry.entryPath, 'version')).mode & 0o222).toBe(0)
    // Entry directories stay removable, which is what the install transaction actually needs.
    expect(() => rmSync(entry.entryPath, { recursive: true })).not.toThrow()
  })

  it('never overwrites an entry another worktree already published', () => {
    const root = makeRoot()
    const entry = makeEntry(root)
    mkdirSync(entry.cacheRoot, { recursive: true })
    writeDist(entry.entryPath)
    writeFileSync(path.join(entry.entryPath, 'marker'), 'first-writer')
    const share = vi.fn()
    expect(publishSharedElectronDist(writeDist(path.join(root, 'dist')), entry, { share })).toBe(
      false
    )
    expect(share).not.toHaveBeenCalled()
    expect(existsSync(path.join(entry.entryPath, 'marker'))).toBe(true)
  })

  it('loses a publish race without clobbering the winner or leaking staging', () => {
    const root = makeRoot()
    const entry = makeEntry(root)
    const share = (_source: string, destination: string) => {
      writeDist(destination)
      // The winner lands between our existence check and our rename.
      writeDist(entry.entryPath)
      writeFileSync(path.join(entry.entryPath, 'marker'), 'winner')
    }
    expect(publishSharedElectronDist(writeDist(path.join(root, 'dist')), entry, { share })).toBe(
      false
    )
    expect(existsSync(path.join(entry.entryPath, 'marker'))).toBe(true)
    expect(readdirSync(entry.cacheRoot)).toEqual([path.basename(entry.entryPath)])
  })

  it('keeps a good entry a sibling published while this one was still sharing', () => {
    const root = makeRoot()
    const entry = makeEntry(root)
    mkdirSync(entry.cacheRoot, { recursive: true })
    writeDist(entry.entryPath, '40.0.0') // Unusable, so this worktree intends to replace it.
    const share = (_source: string, destination: string) => {
      writeDist(destination)
      // A sibling replaces the bad entry with a good one while this share is still running.
      rmSync(entry.entryPath, { recursive: true, force: true })
      writeDist(entry.entryPath)
      writeFileSync(path.join(entry.entryPath, 'marker'), 'sibling')
    }
    expect(
      publishSharedElectronDist(writeDist(path.join(root, 'dist')), entry, { share, ...identity })
    ).toBe(false)
    expect(existsSync(path.join(entry.entryPath, 'marker'))).toBe(true)
    expect(readdirSync(entry.cacheRoot)).toEqual([path.basename(entry.entryPath)])
  })

  it('restores the quarantined entry rather than leaving the cache empty', () => {
    const root = makeRoot()
    const entry = makeEntry(root)
    mkdirSync(entry.cacheRoot, { recursive: true })
    writeDist(entry.entryPath, '40.0.0')
    writeFileSync(path.join(entry.entryPath, 'marker'), 'stale')
    const share = (_source: string, destination: string) => writeDist(destination)
    // The swap itself fails; a bad entry still beats no entry, since the next publisher replaces it.
    const failingRename = () => {
      throw new Error('rename failed')
    }
    expect(
      publishSharedElectronDist(writeDist(path.join(root, 'dist')), entry, {
        share,
        rename: failingRename,
        ...identity
      })
    ).toBe(false)
    expect(existsSync(path.join(entry.entryPath, 'marker'))).toBe(true)
    expect(readdirSync(entry.cacheRoot)).toEqual([path.basename(entry.entryPath)])
  })

  it('replaces an entry that fails validation instead of stranding every worktree', () => {
    const root = makeRoot()
    const entry = makeEntry(root)
    mkdirSync(entry.cacheRoot, { recursive: true })
    writeDist(entry.entryPath, '40.0.0')
    const share = (_source: string, destination: string) => writeDist(destination)
    expect(
      publishSharedElectronDist(writeDist(path.join(root, 'dist')), entry, { share, ...identity })
    ).toBe(true)
    expect(isUsableElectronDist(entry.entryPath, VERSION, PLATFORM_PATH)).toBe(true)
    expect(readdirSync(entry.cacheRoot)).toEqual([path.basename(entry.entryPath)])
  })

  it('never discards an entry it was given no identity to check', () => {
    const root = makeRoot()
    const entry = makeEntry(root)
    mkdirSync(entry.cacheRoot, { recursive: true })
    writeDist(entry.entryPath, '40.0.0')
    const share = vi.fn()
    expect(publishSharedElectronDist(writeDist(path.join(root, 'dist')), entry, { share })).toBe(
      false
    )
    expect(share).not.toHaveBeenCalled()
    expect(existsSync(path.join(entry.entryPath, 'version'))).toBe(true)
  })

  it('leaves no entry and no staging tree when sharing fails', () => {
    const root = makeRoot()
    const entry = makeEntry(root)
    const share = (_source: string, destination: string) => {
      writeDist(destination)
      throw new Error('no shareable storage')
    }
    expect(publishSharedElectronDist(writeDist(path.join(root, 'dist')), entry, { share })).toBe(
      false
    )
    expect(existsSync(entry.entryPath)).toBe(false)
    expect(readdirSync(entry.cacheRoot)).toEqual([])
  })
})

describe('shareElectronDistFromCache', () => {
  it('shares a validated entry with real filesystem semantics', () => {
    const root = makeRoot()
    const entry = makeEntry(root)
    mkdirSync(entry.cacheRoot, { recursive: true })
    writeDist(entry.entryPath)
    const stagePath = path.join(root, 'stage')
    expect(
      shareElectronDistFromCache(entry, stagePath, {
        version: VERSION,
        platformPath: PLATFORM_PATH
      })
    ).toBe(true)
    expect(isUsableElectronDist(stagePath, VERSION, PLATFORM_PATH)).toBe(true)
  })

  it('refuses an entry that fails validation instead of installing it', () => {
    const root = makeRoot()
    const entry = makeEntry(root)
    mkdirSync(entry.cacheRoot, { recursive: true })
    writeDist(entry.entryPath, '40.0.0')
    const stagePath = path.join(root, 'stage')
    expect(
      shareElectronDistFromCache(entry, stagePath, {
        version: VERSION,
        platformPath: PLATFORM_PATH
      })
    ).toBe(false)
    expect(existsSync(stagePath)).toBe(false)
  })

  it('reports failure rather than falling back to a full copy', () => {
    const root = makeRoot()
    const entry = makeEntry(root)
    mkdirSync(entry.cacheRoot, { recursive: true })
    writeDist(entry.entryPath)
    // Injected rather than provoked: what counts as an unshareable destination differs per
    // mechanism, and a byte-copy fallback here would defeat the point of the cache.
    const stagePath = path.join(root, 'stage')
    const share = () => {
      throw new Error('no shareable storage')
    }
    expect(
      shareElectronDistFromCache(entry, stagePath, {
        version: VERSION,
        platformPath: PLATFORM_PATH,
        share
      })
    ).toBe(false)
    expect(existsSync(stagePath)).toBe(false)
  })
})

describe('shared dist marker', () => {
  it('reports adoption only for the entry the marker names', () => {
    const root = makeRoot()
    const entry = makeEntry(root)
    expect(hasAdoptedSharedElectronDist(entry)).toBe(false)
    recordAdoptedSharedElectronDist(entry, writeFileSync)
    expect(hasAdoptedSharedElectronDist(entry)).toBe(true)
    expect(
      hasAdoptedSharedElectronDist({
        ...entry,
        entryPath: path.join(entry.cacheRoot, '44.0.0-darwin-arm64')
      })
    ).toBe(false)
  })

  it('swallows a marker write failure, which only costs one extra share', () => {
    const entry = makeEntry(makeRoot())
    expect(() =>
      recordAdoptedSharedElectronDist(entry, () => {
        throw new Error('read-only node_modules')
      })
    ).not.toThrow()
  })
})
