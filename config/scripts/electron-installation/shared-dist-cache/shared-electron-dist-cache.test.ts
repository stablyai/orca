import type { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  shareElectronDistFromCache,
  isUsableElectronDist,
  publishSharedElectronDist,
  resolveSharedElectronDistEntry
} from './shared-electron-dist-cache.mjs'

const VERSION = '43.4.1'
const PLATFORM_PATH = path.join('Electron.app', 'Contents', 'MacOS', 'Electron')
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
  env: {} as NodeJS.ProcessEnv,
  execFile: (() => '/repo/.git\n') as unknown as typeof execFileSync
}

describe('resolveSharedElectronDistEntry', () => {
  it('declines an identity that would not be a single safe path segment', () => {
    expect(resolveSharedElectronDistEntry({ ...baseOptions, targetArch: '../escape' })).toBeNull()
    expect(resolveSharedElectronDistEntry({ ...baseOptions, targetPlatform: 'dar/win' })).toBeNull()
    expect(resolveSharedElectronDistEntry({ ...baseOptions, version: '' })).toBeNull()
  })
})

describe('isUsableElectronDist', () => {
  it('rejects a symlink so a redirected entry is never treated as cache content', () => {
    const root = makeRoot()
    writeDist(path.join(root, 'real'))
    symlinkSync(path.join(root, 'real'), path.join(root, 'link'), 'dir')
    expect(isUsableElectronDist(path.join(root, 'link'), VERSION, PLATFORM_PATH)).toBe(false)
  })
})

describe('publishSharedElectronDist', () => {
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
    // Stub mechanism-dependent sharing failures; byte-copy fallback would defeat cache’s storage purpose.
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
