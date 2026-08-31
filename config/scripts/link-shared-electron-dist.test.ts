import {
  cpSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  copyElectronDist,
  createDirectoryLink,
  resolveGitCommonDir,
  runPrepareInstallMain,
  runShareMain,
  shareDevElectronDist
} from './link-shared-electron-dist.mjs'

const tempDirs: string[] = []

function createTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'orca-electron-share-'))
  tempDirs.push(dir)
  return dir
}

function createElectronPackage(root: string, version: string, contents: string): string {
  const packageDir = path.join(root, 'node_modules', 'electron')
  const distDir = path.join(packageDir, 'dist')
  mkdirSync(distDir, { recursive: true })
  writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({ version }))
  writeFileSync(path.join(packageDir, 'path.txt'), 'electron')
  writeFileSync(path.join(distDir, 'version'), version)
  writeFileSync(path.join(distDir, 'electron'), contents, { mode: 0o755 })
  return packageDir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('link-shared-electron-dist', () => {
  it('publishes one shared dist and links the worktree package to it', async () => {
    const root = createTempDir()
    const gitCommonDir = path.join(root, 'primary', '.git')
    const electronPackageDir = createElectronPackage(
      path.join(root, 'worktree'),
      '43.4.1',
      'first binary'
    )
    mkdirSync(gitCommonDir, { recursive: true })

    const result = await shareDevElectronDist({
      electronPackageDir,
      gitCommonDir,
      platform: 'linux',
      targetArch: 'x64',
      targetPlatform: 'linux'
    })

    expect(realpathSync(path.join(electronPackageDir, 'dist'))).toBe(
      realpathSync(result.sharedDistPath)
    )
    expect(readFileSync(path.join(result.sharedDistPath, 'electron'), 'utf8')).toBe('first binary')
  })

  it('links a second worktree without replacing the published dist', async () => {
    const root = createTempDir()
    const gitCommonDir = path.join(root, 'primary', '.git')
    const firstPackage = createElectronPackage(path.join(root, 'first'), '43.4.1', 'first binary')
    const secondPackage = createElectronPackage(
      path.join(root, 'second'),
      '43.4.1',
      'second binary'
    )
    mkdirSync(gitCommonDir, { recursive: true })

    const first = await shareDevElectronDist({
      electronPackageDir: firstPackage,
      gitCommonDir,
      platform: 'linux',
      targetArch: 'x64',
      targetPlatform: 'linux'
    })
    const second = await shareDevElectronDist({
      electronPackageDir: secondPackage,
      gitCommonDir,
      platform: 'linux',
      targetArch: 'x64',
      targetPlatform: 'linux'
    })

    expect(second.sharedDistPath).toBe(first.sharedDistPath)
    expect(realpathSync(path.join(secondPackage, 'dist'))).toBe(realpathSync(first.sharedDistPath))
    expect(readFileSync(path.join(first.sharedDistPath, 'electron'), 'utf8')).toBe('first binary')
  })

  it('is idempotent when the package already links to the shared dist', async () => {
    const root = createTempDir()
    const gitCommonDir = path.join(root, '.git')
    const electronPackageDir = createElectronPackage(root, '43.4.1', 'binary')
    mkdirSync(gitCommonDir, { recursive: true })

    const first = await shareDevElectronDist({
      electronPackageDir,
      gitCommonDir,
      platform: 'linux',
      targetArch: 'x64',
      targetPlatform: 'linux'
    })
    const second = await shareDevElectronDist({
      electronPackageDir,
      gitCommonDir,
      platform: 'linux',
      targetArch: 'x64',
      targetPlatform: 'linux'
    })

    expect(second.sharedDistPath).toBe(first.sharedDistPath)
    expect(realpathSync(path.join(electronPackageDir, 'dist'))).toBe(
      realpathSync(first.sharedDistPath)
    )
  })

  it('detaches an owned link before an Electron version upgrade', async () => {
    const root = createTempDir()
    const gitCommonDir = path.join(root, '.git')
    const electronPackageDir = createElectronPackage(root, '43.4.1', 'v43 binary')
    mkdirSync(gitCommonDir, { recursive: true })

    const first = await shareDevElectronDist({
      electronPackageDir,
      gitCommonDir,
      platform: 'linux',
      targetArch: 'x64',
      targetPlatform: 'linux'
    })
    writeFileSync(
      path.join(electronPackageDir, 'package.json'),
      JSON.stringify({ version: '44.0.0' })
    )

    const { prepareElectronDistForInstall } = await import('./link-shared-electron-dist.mjs')
    const result = prepareElectronDistForInstall({
      electronPackageDir,
      gitCommonDir,
      platform: 'darwin',
      copyDist: (source: string, target: string) => {
        cpSync(source, target, { recursive: true, verbatimSymlinks: true })
      }
    })

    expect(result).toEqual({
      detached: true,
      copied: true,
      reason: 'owned-link',
      localDistPath: path.join(electronPackageDir, 'dist')
    })
    expect(lstatSync(path.join(electronPackageDir, 'dist')).isSymbolicLink()).toBe(false)
    expect(readFileSync(path.join(electronPackageDir, 'dist', 'electron'), 'utf8')).toBe(
      'v43 binary'
    )
    expect(readFileSync(path.join(first.sharedDistPath, 'version'), 'utf8')).toBe('43.4.1')
  })

  it('removes a dangling owned link so reinstall can recreate Electron', async () => {
    const root = createTempDir()
    const gitCommonDir = path.join(root, '.git')
    const electronPackageDir = createElectronPackage(root, '43.4.1', 'binary')
    mkdirSync(gitCommonDir, { recursive: true })
    const cachePath = path.join(gitCommonDir, 'orca-cache', 'electron', 'missing')
    mkdirSync(path.dirname(cachePath), { recursive: true })
    rmSync(path.join(electronPackageDir, 'dist'), { recursive: true, force: true })
    symlinkSync(cachePath, path.join(electronPackageDir, 'dist'), 'dir')

    const { prepareElectronDistForInstall } = await import('./link-shared-electron-dist.mjs')
    const result = prepareElectronDistForInstall({
      electronPackageDir,
      gitCommonDir,
      platform: 'darwin'
    })

    expect(result).toEqual({
      detached: true,
      copied: false,
      reason: 'missing-cache',
      localDistPath: path.join(electronPackageDir, 'dist')
    })
    expect(existsSync(path.join(electronPackageDir, 'dist'))).toBe(false)
    expect(() => readFileSync(path.join(electronPackageDir, 'dist', 'version'))).toThrow()
  })

  it('does not consume an external Electron symlink', async () => {
    const root = createTempDir()
    const gitCommonDir = path.join(root, '.git')
    const electronPackageDir = createElectronPackage(root, '43.4.1', 'local')
    const externalDist = path.join(root, 'external-dist')
    mkdirSync(externalDist, { recursive: true })
    writeFileSync(path.join(externalDist, 'version'), '43.4.1')
    writeFileSync(path.join(externalDist, 'electron'), 'external')
    mkdirSync(gitCommonDir, { recursive: true })
    rmSync(path.join(electronPackageDir, 'dist'), { recursive: true, force: true })
    symlinkSync(externalDist, path.join(electronPackageDir, 'dist'), 'dir')

    await expect(
      shareDevElectronDist({
        electronPackageDir,
        gitCommonDir,
        platform: 'darwin',
        targetArch: 'arm64',
        targetPlatform: 'darwin'
      })
    ).rejects.toThrow('outside')
    expect(readFileSync(path.join(externalDist, 'electron'), 'utf8')).toBe('external')
  })

  it('rejects a cache entry that redirects through a symlink', async () => {
    const root = createTempDir()
    const gitCommonDir = path.join(root, '.git')
    const electronPackageDir = createElectronPackage(root, '43.4.1', 'local')
    const cacheRoot = path.join(gitCommonDir, 'orca-cache', 'electron')
    const externalDist = path.join(root, 'external-dist')
    mkdirSync(cacheRoot, { recursive: true })
    mkdirSync(externalDist, { recursive: true })
    writeFileSync(path.join(externalDist, 'version'), '43.4.1')
    writeFileSync(path.join(externalDist, 'electron'), 'external')
    const redirectedCacheEntry = path.join(cacheRoot, 'redirected')
    symlinkSync(externalDist, redirectedCacheEntry, 'dir')
    rmSync(path.join(electronPackageDir, 'dist'), { recursive: true, force: true })
    symlinkSync(redirectedCacheEntry, path.join(electronPackageDir, 'dist'), 'dir')

    await expect(
      shareDevElectronDist({
        electronPackageDir,
        gitCommonDir,
        platform: 'darwin',
        targetArch: 'arm64',
        targetPlatform: 'darwin'
      })
    ).rejects.toThrow('outside')
    expect(readFileSync(path.join(externalDist, 'electron'), 'utf8')).toBe('external')
  })

  it('cleans a partial macOS clone before falling back to a regular copy', () => {
    const cloneError = new Error('clonefile unavailable')
    const clone = vi.fn(() => {
      throw cloneError
    })
    const removePartial = vi.fn()
    const copy = vi.fn()

    copyElectronDist('/source', '/staging', {
      platform: 'darwin',
      clone,
      removePartial,
      copy
    })

    expect(removePartial).toHaveBeenCalledWith('/staging')
    expect(copy).toHaveBeenCalledWith('/source', '/staging')
    expect(removePartial.mock.invocationCallOrder[0]).toBeLessThan(copy.mock.invocationCallOrder[0])
  })

  it('does not merge a regular copy when partial-clone cleanup fails', () => {
    const cloneError = new Error('clonefile unavailable')
    const cleanupError = new Error('staging directory is locked')
    const copy = vi.fn()

    expect(() =>
      copyElectronDist('/source', '/staging', {
        platform: 'darwin',
        clone: () => {
          throw cloneError
        },
        removePartial: () => {
          throw cleanupError
        },
        copy
      })
    ).toThrow(AggregateError)
    expect(copy).not.toHaveBeenCalled()
  })

  it('allows preinstall to continue after a failed detach only when the link is gone', () => {
    const root = createTempDir()
    const localDistPath = path.join(root, 'dist')
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() }

    const status = runPrepareInstallMain({
      localDistPath,
      logger,
      prepare: () => {
        throw new Error('detach failed after removing link')
      }
    })

    expect(status).toBe(0)
    expect(logger.warn).toHaveBeenCalled()
    expect(logger.error).not.toHaveBeenCalled()
  })

  it('fails closed when an owned-link detach failure leaves a symlink', () => {
    const root = createTempDir()
    const localDistPath = path.join(root, 'dist')
    const targetPath = path.join(root, 'target')
    mkdirSync(targetPath, { recursive: true })
    symlinkSync(targetPath, localDistPath, 'dir')
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() }

    const status = runPrepareInstallMain({
      localDistPath,
      logger,
      prepare: () => {
        throw new Error('detach failed while link remains')
      }
    })

    expect(status).toBe(1)
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('shared dist link remains'))
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('fails closed when a foreign link remains during preinstall', () => {
    const root = createTempDir()
    const localDistPath = path.join(root, 'dist')
    const targetPath = path.join(root, 'foreign')
    mkdirSync(targetPath, { recursive: true })
    symlinkSync(targetPath, localDistPath, 'dir')
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() }

    const status = runPrepareInstallMain({
      localDistPath,
      logger,
      prepare: () => ({ detached: false, reason: 'foreign-link', localDistPath })
    })

    expect(status).toBe(1)
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Refusing to run Electron install through non-Orca dist link')
    )
    expect(logger.error).not.toHaveBeenCalled()
  })

  it('keeps the preinstall guard inert off macOS', () => {
    const root = createTempDir()
    const localDistPath = path.join(root, 'dist')
    const targetPath = path.join(root, 'target')
    mkdirSync(targetPath, { recursive: true })
    symlinkSync(targetPath, localDistPath, 'dir')
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() }

    const status = runPrepareInstallMain({
      localDistPath,
      logger,
      prepare: () => ({ detached: false, reason: 'platform', localDistPath })
    })

    expect(status).toBe(0)
    expect(logger.error).not.toHaveBeenCalled()
    expect(lstatSync(localDistPath).isSymbolicLink()).toBe(true)
  })

  it('serializes concurrent publication for the same Electron identity', async () => {
    const root = createTempDir()
    const gitCommonDir = path.join(root, '.git')
    const firstPackage = createElectronPackage(path.join(root, 'first'), '43.4.1', 'first')
    const secondPackage = createElectronPackage(path.join(root, 'second'), '43.4.1', 'second')
    mkdirSync(gitCommonDir, { recursive: true })

    const [first, second] = await Promise.all(
      [firstPackage, secondPackage].map((electronPackageDir) =>
        shareDevElectronDist({
          electronPackageDir,
          gitCommonDir,
          platform: 'linux',
          targetArch: 'x64',
          targetPlatform: 'linux'
        })
      )
    )

    expect(second.sharedDistPath).toBe(first.sharedDistPath)
    expect(realpathSync(path.join(firstPackage, 'dist'))).toBe(realpathSync(first.sharedDistPath))
    expect(realpathSync(path.join(secondPackage, 'dist'))).toBe(realpathSync(first.sharedDistPath))
  })

  it('keeps different Electron versions in separate shared directories', async () => {
    const root = createTempDir()
    const gitCommonDir = path.join(root, '.git')
    const oldPackage = createElectronPackage(path.join(root, 'old'), '42.0.0', 'old')
    const newPackage = createElectronPackage(path.join(root, 'new'), '43.0.0', 'new')
    mkdirSync(gitCommonDir, { recursive: true })

    const oldResult = await shareDevElectronDist({
      electronPackageDir: oldPackage,
      gitCommonDir,
      platform: 'linux',
      targetArch: 'x64',
      targetPlatform: 'linux'
    })
    const newResult = await shareDevElectronDist({
      electronPackageDir: newPackage,
      gitCommonDir,
      platform: 'linux',
      targetArch: 'x64',
      targetPlatform: 'linux'
    })

    expect(newResult.sharedDistPath).not.toBe(oldResult.sharedDistPath)
    expect(readFileSync(path.join(oldResult.sharedDistPath, 'electron'), 'utf8')).toBe('old')
    expect(readFileSync(path.join(newResult.sharedDistPath, 'electron'), 'utf8')).toBe('new')
  })

  it('restores the worktree copy when directory linking fails', async () => {
    const root = createTempDir()
    const gitCommonDir = path.join(root, '.git')
    const electronPackageDir = createElectronPackage(root, '43.4.1', 'local binary')
    mkdirSync(gitCommonDir, { recursive: true })

    await expect(
      shareDevElectronDist({
        electronPackageDir,
        gitCommonDir,
        linkDirectory: () => {
          throw new Error('link unavailable')
        },
        platform: 'linux',
        targetArch: 'x64',
        targetPlatform: 'linux'
      })
    ).rejects.toThrow('link unavailable')

    expect(readFileSync(path.join(electronPackageDir, 'dist', 'electron'), 'utf8')).toBe(
      'local binary'
    )
  })

  it('leaves a local copy alone when an existing shared dist is invalid', async () => {
    const root = createTempDir()
    const gitCommonDir = path.join(root, '.git')
    const electronPackageDir = createElectronPackage(root, '43.4.1', 'local binary')
    mkdirSync(gitCommonDir, { recursive: true })

    const first = await shareDevElectronDist({
      electronPackageDir,
      gitCommonDir,
      platform: 'linux',
      targetArch: 'x64',
      targetPlatform: 'linux'
    })
    rmSync(path.join(electronPackageDir, 'dist'))
    createElectronPackage(root, '43.4.1', 'restored local binary')
    writeFileSync(path.join(first.sharedDistPath, 'version'), 'broken')

    await expect(
      shareDevElectronDist({
        electronPackageDir,
        gitCommonDir,
        platform: 'linux',
        targetArch: 'x64',
        targetPlatform: 'linux'
      })
    ).rejects.toThrow('incomplete')
    expect(readFileSync(path.join(electronPackageDir, 'dist', 'electron'), 'utf8')).toBe(
      'restored local binary'
    )
  })

  it('resolves relative Git common directories against the worktree root', () => {
    const execFile = vi.fn(() => '.git\n')

    expect(resolveGitCommonDir('/repo', execFile)).toBe(path.resolve('/repo/.git'))
    expect(execFile).toHaveBeenCalledWith('git', ['-C', '/repo', 'rev-parse', '--git-common-dir'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    })
  })

  it('falls back from a Windows junction to a directory symlink', () => {
    const create = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('junction unavailable')
      })
      .mockImplementationOnce(() => undefined)

    createDirectoryLink('C:\\shared', 'C:\\local', 'win32', create)

    expect(create.mock.calls).toEqual([
      ['C:\\shared', 'C:\\local', 'junction'],
      ['C:\\shared', 'C:\\local', 'dir']
    ])
  })

  it('keeps setup successful when sharing fails', async () => {
    const logger = { log: vi.fn(), warn: vi.fn() }

    await expect(
      runShareMain({
        logger,
        platform: 'darwin',
        env: {},
        share: async () => {
          throw new Error('cache unavailable')
        }
      })
    ).resolves.toBeNull()
    expect(logger.log).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledWith(
      "[electron-share] Keeping this worktree's Electron copy: cache unavailable"
    )
  })

  it('does not mutate installs in CI', async () => {
    const share = vi.fn()

    await expect(
      runShareMain({ platform: 'darwin', env: { CI: 'true' }, share })
    ).resolves.toBeNull()
    expect(share).not.toHaveBeenCalled()
  })

  it('does not change Electron installs off macOS', async () => {
    const share = vi.fn()

    await expect(runShareMain({ platform: 'linux', share })).resolves.toBeNull()
    expect(share).not.toHaveBeenCalled()
  })
})
