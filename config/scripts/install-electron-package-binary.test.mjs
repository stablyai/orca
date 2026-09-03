import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  addSiblingWorktree,
  initGitRepo,
  mkTempProject,
  readExtractorCallCount,
  readSharedDistMarker,
  runInstallScript,
  sharedCacheRoot,
  sharedEntryName,
  sharedEntryNameFor,
  writeFakeElectronDist,
  writeFakeElectronGet,
  writeFakeElectronPackage,
  writeFakeExtractor,
  writeNonDarwinPlatformPreload,
  writeTypeDefPublishFailurePreload
} from './install-electron-package-binary-test-fixtures.mjs'

describe('install-electron-package-binary', () => {
  it('installs Electron from an isolated cache and repairs path.txt', () => {
    const projectDir = mkTempProject()

    try {
      writeFakeElectronPackage(projectDir)
      writeFakeElectronGet(projectDir)
      writeFakeExtractor(projectDir, { createExecutable: true })
      writeFakeElectronDist(projectDir, {
        version: 'v40.0.0',
        executableContents: 'old executable',
        pathContents: 'stale-path'
      })

      const result = runInstallScript(projectDir)

      expect(result.status, result.stderr).toBe(0)
      expect(readFileSync(join(projectDir, 'electron-get.log'), 'utf8')).toMatch(
        /cacheRoot=.*orca-electron-.*cache/
      )
      expect(readFileSync(join(projectDir, 'electron-get.log'), 'utf8')).toContain('force=true')
      expect(readFileSync(join(projectDir, 'node_modules', 'electron', 'path.txt'), 'utf8')).toBe(
        'electron'
      )
      expect(readFileSync(join(projectDir, 'node_modules/electron/electron.d.ts'), 'utf8')).toBe(
        'replacement types'
      )
      expect(existsSync(join(projectDir, 'node_modules/electron/dist/electron.d.ts'))).toBe(false)
      if (process.platform !== 'win32') {
        expect(
          lstatSync(
            join(projectDir, 'node_modules', 'electron', 'dist', 'version-link')
          ).isSymbolicLink()
        ).toBe(true)
      }
      expect(result.stdout).toContain('Repaired Electron path.txt -> electron')
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  it('repairs existing Electron path metadata without downloading', () => {
    const projectDir = mkTempProject()

    try {
      writeFakeElectronPackage(projectDir)
      writeFakeElectronGet(projectDir)
      writeFakeElectronDist(projectDir)

      const result = runInstallScript(projectDir)

      expect(result.status, result.stderr).toBe(0)
      expect(readFileSync(join(projectDir, 'node_modules/electron/path.txt'), 'utf8')).toBe(
        'electron'
      )
      expect(result.stdout).toContain('Repaired Electron path.txt -> electron')
      expect(existsSync(join(projectDir, 'electron-get.log'))).toBe(false)
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  it('reuses a configured persistent cache without forcing a fresh download', () => {
    const projectDir = mkTempProject()
    const cacheRoot = join(projectDir, 'electron-cache')

    try {
      writeFakeElectronPackage(projectDir)
      writeFakeElectronGet(projectDir)
      writeFakeExtractor(projectDir, { createExecutable: true })

      const result = runInstallScript(projectDir, {
        ORCA_ELECTRON_PACKAGE_CACHE_ROOT: cacheRoot
      })

      expect(result.status, result.stderr).toBe(0)
      expect(readFileSync(join(projectDir, 'electron-get.log'), 'utf8')).toContain(
        `cacheRoot=${cacheRoot} platform=linux arch=x64 force=false`
      )
      expect(existsSync(cacheRoot)).toBe(true)
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  it('preserves an existing Electron distribution when replacement download fails', () => {
    const projectDir = mkTempProject()

    try {
      writeFakeElectronPackage(projectDir)
      writeFakeElectronGet(projectDir, { downloadFailures: 1, downloadErrorCode: 'EACCES' })
      writeFakeElectronDist(projectDir, {
        version: 'v40.0.0',
        executableContents: 'existing executable',
        pathContents: 'electron'
      })

      const result = runInstallScript(projectDir)
      const electronDir = join(projectDir, 'node_modules/electron')

      expect(result.status).toBe(1)
      expect(readFileSync(join(electronDir, 'dist/version'), 'utf8')).toBe('v40.0.0')
      expect(readFileSync(join(electronDir, 'dist/electron'), 'utf8')).toBe('existing executable')
      expect(readFileSync(join(electronDir, 'path.txt'), 'utf8')).toBe('electron')
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  it('restores an existing Electron distribution when publishing its type definitions fails', () => {
    const projectDir = mkTempProject()

    try {
      writeFakeElectronPackage(projectDir)
      writeFakeElectronGet(projectDir)
      writeFakeExtractor(projectDir, { createExecutable: true })
      writeFakeElectronDist(projectDir, {
        version: 'v40.0.0',
        executableContents: 'existing executable',
        pathContents: 'electron'
      })
      writeFileSync(join(projectDir, 'node_modules/electron/electron.d.ts'), 'existing types')
      const preloadPath = writeTypeDefPublishFailurePreload(projectDir)

      const result = runInstallScript(projectDir, {
        NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require=${preloadPath}`]
          .filter(Boolean)
          .join(' ')
      })
      const electronDir = join(projectDir, 'node_modules/electron')

      expect(result.status).toBe(1)
      expect(result.stderr).toContain('injected Electron type definition publish failure')
      expect(readFileSync(join(electronDir, 'dist/version'), 'utf8')).toBe('v40.0.0')
      expect(readFileSync(join(electronDir, 'dist/electron'), 'utf8')).toBe('existing executable')
      expect(readFileSync(join(electronDir, 'path.txt'), 'utf8')).toBe('electron')
      expect(readFileSync(join(electronDir, 'electron.d.ts'), 'utf8')).toBe('existing types')
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  it('uses Electron 42 install env vars before npm config platform flags', () => {
    const projectDir = mkTempProject()

    try {
      writeFakeElectronPackage(projectDir)
      writeFakeElectronGet(projectDir)
      writeFakeExtractor(projectDir, { createExecutable: true })

      const result = runInstallScript(projectDir, {
        ELECTRON_INSTALL_PLATFORM: 'win32',
        ELECTRON_INSTALL_ARCH: 'arm64',
        npm_config_platform: 'linux',
        npm_config_arch: 'x64'
      })

      expect(result.status, result.stderr).toBe(0)
      expect(readFileSync(join(projectDir, 'electron-get.log'), 'utf8')).toContain(
        'platform=win32 arch=arm64'
      )
      expect(readFileSync(join(projectDir, 'node_modules', 'electron', 'path.txt'), 'utf8')).toBe(
        'electron.exe'
      )
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  it('does not trigger Electron 42 lazy require downloads while checking install state', () => {
    const projectDir = mkTempProject()

    try {
      writeFakeElectronPackage(projectDir, { lazyRequireMarker: 'lazy-require.marker' })
      writeFakeElectronGet(projectDir)
      writeFakeExtractor(projectDir, { createExecutable: true })

      const result = runInstallScript(projectDir)

      expect(result.status, result.stderr).toBe(0)
      expect(existsSync(join(projectDir, 'lazy-require.marker'))).toBe(false)
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  it('retries transient Electron download failures', () => {
    const projectDir = mkTempProject()

    try {
      writeFakeElectronPackage(projectDir)
      writeFakeElectronGet(projectDir, {
        downloadFailures: 1,
        downloadErrorCode: 'ECONNRESET'
      })
      writeFakeExtractor(projectDir, { createExecutable: true })

      const result = runInstallScript(projectDir, {
        ORCA_ELECTRON_PACKAGE_RETRY_DELAYS_MS: '0,0'
      })

      expect(result.status, result.stderr).toBe(0)
      expect(
        readFileSync(join(projectDir, 'electron-get.log'), 'utf8').trim().split('\n')
      ).toHaveLength(2)
      expect(result.stderr).toContain('Transient Electron download failure (ECONNRESET)')
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  it('keeps a persistent cache root while retrying transient failures', () => {
    const projectDir = mkTempProject()
    const cacheRoot = join(projectDir, 'electron-cache')

    try {
      writeFakeElectronPackage(projectDir)
      writeFakeElectronGet(projectDir, {
        downloadFailures: 1,
        downloadErrorCode: 'ECONNRESET'
      })
      writeFakeExtractor(projectDir, { createExecutable: true })
      mkdirSync(cacheRoot, { recursive: true })
      writeFileSync(join(cacheRoot, 'preserved.marker'), 'keep me')

      const result = runInstallScript(projectDir, {
        ORCA_ELECTRON_PACKAGE_CACHE_ROOT: cacheRoot,
        ORCA_ELECTRON_PACKAGE_RETRY_DELAYS_MS: '0,0'
      })

      expect(result.status, result.stderr).toBe(0)
      expect(existsSync(join(cacheRoot, 'preserved.marker'))).toBe(true)
      expect(
        readFileSync(join(projectDir, 'electron-get.log'), 'utf8').trim().split('\n')
      ).toHaveLength(2)
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  it('retries HTTP/2 stream refusal Electron download failures', () => {
    const projectDir = mkTempProject()

    try {
      writeFakeElectronPackage(projectDir)
      writeFakeElectronGet(projectDir, {
        downloadFailures: 1,
        downloadErrorCode: 'ERR_HTTP2_STREAM_ERROR'
      })
      writeFakeExtractor(projectDir, { createExecutable: true })

      const result = runInstallScript(projectDir, {
        ORCA_ELECTRON_PACKAGE_RETRY_DELAYS_MS: '0,0'
      })

      expect(result.status, result.stderr).toBe(0)
      expect(
        readFileSync(join(projectDir, 'electron-get.log'), 'utf8').trim().split('\n')
      ).toHaveLength(2)
      expect(result.stderr).toContain(
        'Transient Electron download failure (ERR_HTTP2_STREAM_ERROR)'
      )
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  it('retries Electron download HTTP 503 failures from Fetch Response.status', () => {
    const projectDir = mkTempProject()

    try {
      writeFakeElectronPackage(projectDir)
      writeFakeElectronGet(projectDir, {
        downloadFailures: 1,
        downloadHttpStatus: 503
      })
      writeFakeExtractor(projectDir, { createExecutable: true })

      const result = runInstallScript(projectDir, {
        ORCA_ELECTRON_PACKAGE_RETRY_DELAYS_MS: '0,0'
      })

      expect(result.status, result.stderr).toBe(0)
      expect(
        readFileSync(join(projectDir, 'electron-get.log'), 'utf8').trim().split('\n')
      ).toHaveLength(2)
      expect(result.stderr).toContain('Transient Electron download failure (HTTP 503)')
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  it('fails after exhausting transient Electron download retries', () => {
    const projectDir = mkTempProject()

    try {
      writeFakeElectronPackage(projectDir)
      writeFakeElectronGet(projectDir, {
        downloadFailures: 5,
        downloadErrorCode: 'ECONNRESET'
      })
      writeFakeExtractor(projectDir, { createExecutable: true })

      const result = runInstallScript(projectDir, {
        ORCA_ELECTRON_PACKAGE_RETRY_DELAYS_MS: '0,0'
      })

      expect(result.status).toBe(1)
      expect(
        readFileSync(join(projectDir, 'electron-get.log'), 'utf8').trim().split('\n')
      ).toHaveLength(3)
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  it('rejects invalid Electron download retry delays before downloading', () => {
    const projectDir = mkTempProject()

    try {
      writeFakeElectronPackage(projectDir)
      writeFakeElectronGet(projectDir)
      writeFakeExtractor(projectDir, { createExecutable: true })

      const result = runInstallScript(projectDir, {
        ORCA_ELECTRON_PACKAGE_RETRY_DELAYS_MS: '0,nope'
      })

      expect(result.status).toBe(1)
      expect(result.stderr).toContain(
        'ORCA_ELECTRON_PACKAGE_RETRY_DELAYS_MS must contain non-negative integers'
      )
      expect(existsSync(join(projectDir, 'electron-get.log'))).toBe(false)
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  it('does not retry permanent Electron download failures', () => {
    const projectDir = mkTempProject()

    try {
      writeFakeElectronPackage(projectDir)
      writeFakeElectronGet(projectDir, {
        downloadFailures: 3,
        downloadErrorCode: 'EACCES'
      })
      writeFakeExtractor(projectDir, { createExecutable: true })

      const result = runInstallScript(projectDir, {
        ORCA_ELECTRON_PACKAGE_RETRY_DELAYS_MS: '0,0'
      })

      expect(result.status).toBe(1)
      expect(
        readFileSync(join(projectDir, 'electron-get.log'), 'utf8').trim().split('\n')
      ).toHaveLength(1)
      expect(result.stderr).not.toContain('Transient Electron download failure')
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  it('fails instead of silently accepting a partial Electron extract', () => {
    const projectDir = mkTempProject()

    try {
      writeFakeElectronPackage(projectDir)
      writeFakeElectronGet(projectDir)
      writeFakeExtractor(projectDir, { createExecutable: false })
      mkdirSync(join(projectDir, 'node_modules', 'electron', 'dist', 'locales'), {
        recursive: true
      })
      writeFileSync(join(projectDir, 'node_modules', 'electron', 'path.txt'), 'stale-path')

      const result = runInstallScript(projectDir)

      expect(result.status).toBe(1)
      expect(result.stderr).toContain('Electron archive extract did not contain executable')
      expect(result.stderr).toContain('extractEntries=locales')
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  // The shared cache is macOS-only: it exists to avoid a second copy via APFS clonefile.
  it('publishes a shared Electron dist entry after a fresh download', () => {
    const projectDir = mkTempProject()

    try {
      initGitRepo(projectDir)
      writeFakeElectronPackage(projectDir)
      writeFakeElectronGet(projectDir)
      writeFakeExtractor(projectDir, { createExecutable: true })

      const result = runInstallScript(projectDir, { CI: '' })
      const entryPath = join(sharedCacheRoot(projectDir), sharedEntryName)

      expect(result.status, result.stderr).toBe(0)
      expect(lstatSync(entryPath).isDirectory()).toBe(true)
      expect(lstatSync(entryPath).isSymbolicLink()).toBe(false)
      expect(readFileSync(join(entryPath, 'version'), 'utf8')).toBe('v41.5.0')
      expect(existsSync(join(entryPath, 'electron'))).toBe(true)
      expect(readSharedDistMarker(projectDir)).toBe(sharedEntryName)
      expect(result.stdout).toMatch(/Published Electron 41\.5\.0 to .*41\.5\.0-linux-x64$/m)
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  it('shares the Electron dist into a sibling worktree without downloading', () => {
    const projectDir = mkTempProject()
    const siblingDir = `${projectDir}-sibling`

    try {
      initGitRepo(projectDir)
      writeFakeElectronPackage(projectDir)
      writeFakeElectronGet(projectDir)
      writeFakeExtractor(projectDir, { createExecutable: true })
      expect(runInstallScript(projectDir, { CI: '' }).status).toBe(0)

      addSiblingWorktree(projectDir, siblingDir)
      writeFakeElectronPackage(siblingDir)
      writeFakeElectronGet(siblingDir)
      writeFakeExtractor(siblingDir, { createExecutable: true })

      const result = runInstallScript(siblingDir, { CI: '' })
      const siblingDistDir = join(siblingDir, 'node_modules/electron/dist')

      expect(result.status, result.stderr).toBe(0)
      expect(readExtractorCallCount(siblingDir)).toBe(0)
      expect(existsSync(join(siblingDir, 'electron-get.log'))).toBe(false)
      expect(lstatSync(siblingDistDir).isDirectory()).toBe(true)
      expect(lstatSync(siblingDistDir).isSymbolicLink()).toBe(false)
      expect(readFileSync(join(siblingDistDir, 'version'), 'utf8')).toBe('v41.5.0')
      expect(existsSync(join(siblingDistDir, 'electron'))).toBe(true)
      expect(readFileSync(join(siblingDir, 'node_modules/electron/path.txt'), 'utf8')).toBe(
        'electron'
      )
      expect(readSharedDistMarker(siblingDir)).toBe(sharedEntryName)
      expect(result.stdout).toContain('Shared Electron 41.5.0 from')
    } finally {
      rmSync(siblingDir, { recursive: true, force: true })
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  it('publishes an already installed Electron dist that predates the shared cache', () => {
    const projectDir = mkTempProject()

    try {
      initGitRepo(projectDir)
      writeFakeElectronPackage(projectDir)
      writeFakeElectronGet(projectDir)
      writeFakeExtractor(projectDir, { createExecutable: true })
      writeFakeElectronDist(projectDir, {
        executableContents: 'existing executable',
        pathContents: 'electron'
      })

      const result = runInstallScript(projectDir, { CI: '' })
      const entryPath = join(sharedCacheRoot(projectDir), sharedEntryName)
      const distDir = join(projectDir, 'node_modules/electron/dist')

      expect(result.status, result.stderr).toBe(0)
      expect(readExtractorCallCount(projectDir)).toBe(0)
      expect(existsSync(join(projectDir, 'electron-get.log'))).toBe(false)
      expect(readFileSync(join(entryPath, 'version'), 'utf8')).toBe('v41.5.0')
      expect(readFileSync(join(entryPath, 'electron'), 'utf8')).toBe('existing executable')
      expect(readSharedDistMarker(projectDir)).toBe(sharedEntryName)
      expect(readFileSync(join(distDir, 'electron'), 'utf8')).toBe('existing executable')
      expect(readFileSync(join(distDir, 'version'), 'utf8')).toBe('v41.5.0')
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  it('replaces a corrupt shared Electron dist entry instead of re-downloading forever', () => {
    const projectDir = mkTempProject()

    try {
      initGitRepo(projectDir)
      writeFakeElectronPackage(projectDir)
      writeFakeElectronGet(projectDir)
      writeFakeExtractor(projectDir, { createExecutable: true })
      const entryPath = join(sharedCacheRoot(projectDir), sharedEntryName)
      mkdirSync(entryPath, { recursive: true })
      writeFileSync(join(entryPath, 'version'), 'v40.0.0')
      writeFileSync(join(entryPath, 'electron'), 'stale executable')

      const result = runInstallScript(projectDir, { CI: '' })
      const distDir = join(projectDir, 'node_modules/electron/dist')

      expect(result.status, result.stderr).toBe(0)
      expect(result.stderr).not.toContain('Failed to install Electron package binary')
      expect(readExtractorCallCount(projectDir)).toBe(1)
      expect(readFileSync(join(distDir, 'version'), 'utf8')).toBe('v41.5.0')
      expect(readFileSync(join(projectDir, 'node_modules/electron/path.txt'), 'utf8')).toBe(
        'electron'
      )
      // Why not just fall back: an entry left corrupt makes every sibling worktree download again.
      expect(readFileSync(join(entryPath, 'version'), 'utf8')).toBe('v41.5.0')
      expect(readSharedDistMarker(projectDir)).toBe(sharedEntryName)
      expect(readdirSync(sharedCacheRoot(projectDir))).toEqual([sharedEntryName])
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  it('hardlinks the shared Electron dist on a host without copy-on-write', () => {
    const projectDir = mkTempProject()

    try {
      initGitRepo(projectDir)
      writeFakeElectronPackage(projectDir)
      writeFakeElectronGet(projectDir)
      writeFakeExtractor(projectDir, { createExecutable: true })
      const preloadPath = writeNonDarwinPlatformPreload(projectDir)
      const nonDarwinEnv = {
        CI: '',
        NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require=${preloadPath}`]
          .filter(Boolean)
          .join(' ')
      }

      const result = runInstallScript(projectDir, nonDarwinEnv)
      const entryPath = join(sharedCacheRoot(projectDir), sharedEntryName)
      const distDir = join(projectDir, 'node_modules/electron/dist')

      expect(result.status, result.stderr).toBe(0)
      expect(readFileSync(join(distDir, 'version'), 'utf8')).toBe('v41.5.0')
      expect(readFileSync(join(entryPath, 'version'), 'utf8')).toBe('v41.5.0')
      // Why read-only: these are the same inodes, so an extract over dist would otherwise rewrite
      // the cache and every sibling worktree at once.
      expect(statSync(join(entryPath, 'electron')).mode & 0o222).toBe(0)
      expect(statSync(join(entryPath, 'electron')).ino).toBe(
        statSync(join(distDir, 'electron')).ino
      )
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  it('gives an Electron upgrade its own cache entry and leaves the old one for other branches', () => {
    const projectDir = mkTempProject()

    try {
      initGitRepo(projectDir)
      writeFakeElectronPackage(projectDir)
      writeFakeElectronGet(projectDir)
      writeFakeExtractor(projectDir, { createExecutable: true })
      expect(runInstallScript(projectDir, { CI: '' }).status).toBe(0)
      expect(readSharedDistMarker(projectDir)).toBe(sharedEntryNameFor('41.5.0'))

      // Upgrade the pinned Electron, exactly as a branch bumping the dependency would.
      writeFakeElectronPackage(projectDir, { version: '42.0.0' })
      writeFakeExtractor(projectDir, { createExecutable: true, version: '42.0.0' })
      const upgraded = runInstallScript(projectDir, { CI: '' })
      const cacheRoot = sharedCacheRoot(projectDir)

      expect(upgraded.status, upgraded.stderr).toBe(0)
      expect(readFileSync(join(projectDir, 'node_modules/electron/dist/version'), 'utf8')).toBe(
        'v42.0.0'
      )
      expect(readSharedDistMarker(projectDir)).toBe(sharedEntryNameFor('42.0.0'))
      // Why the old entry stays: sibling worktrees on the previous branch still share it.
      expect(readdirSync(cacheRoot).sort()).toEqual([
        sharedEntryNameFor('41.5.0'),
        sharedEntryNameFor('42.0.0')
      ])
      expect(readFileSync(join(cacheRoot, sharedEntryNameFor('41.5.0'), 'version'), 'utf8')).toBe(
        'v41.5.0'
      )
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  it('does not exit successfully when Electron download never settles', () => {
    const projectDir = mkTempProject()

    try {
      writeFakeElectronPackage(projectDir)
      writeFakeElectronGet(projectDir, { downloadNeverSettles: true })
      writeFakeExtractor(projectDir, { createExecutable: false })

      const result = runInstallScript(projectDir)

      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('Detected unsettled top-level await')
      expect(existsSync(join(projectDir, 'node_modules', 'electron', 'path.txt'))).toBe(false)
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })
})
