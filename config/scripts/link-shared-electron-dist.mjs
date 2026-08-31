#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync
} from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)
const defaultRepoRoot = path.resolve(import.meta.dirname, '../..')
const PREPARE_INSTALL_FLAG = '--prepare-install'

export async function shareDevElectronDist(options = {}) {
  const repoRoot = options.repoRoot ?? defaultRepoRoot
  const electronPackageDir =
    options.electronPackageDir ?? path.join(repoRoot, 'node_modules', 'electron')
  const env = options.env ?? process.env
  const targetPlatform = options.targetPlatform ?? getElectronTargetPlatform(env)
  const targetArch = options.targetArch ?? getElectronTargetArch(targetPlatform, env)
  const platformPath = getElectronPlatformPath(targetPlatform)
  const electronVersion = JSON.parse(
    readFileSync(path.join(electronPackageDir, 'package.json'), 'utf8')
  ).version
  const localDistPath = path.join(electronPackageDir, 'dist')
  const gitCommonDir =
    options.gitCommonDir ?? resolveGitCommonDir(repoRoot, options.execFile ?? execFileSync)
  const cacheRoot = path.join(gitCommonDir, 'orca-cache', 'electron')
  const cacheKey = createCacheKey(electronVersion, targetPlatform, targetArch)
  const sharedDistPath = path.join(cacheRoot, cacheKey)
  mkdirSync(cacheRoot, { recursive: true })

  const localLinkTarget = getOwnedSharedDistTarget(localDistPath, cacheRoot)
  if (isSymlink(localDistPath) && localLinkTarget === null) {
    throw new Error(`Refusing to replace Electron dist symlink outside ${cacheRoot}`)
  }
  if (isSymlink(localDistPath) && !pathsResolveToSameLocation(localDistPath, sharedDistPath)) {
    // A package upgrade may leave the old cache link in place until preinstall runs.
    // Detach it before validating or publishing any new version.
    prepareElectronDistForInstall({
      repoRoot,
      electronPackageDir,
      gitCommonDir,
      platform: options.platform ?? process.platform,
      copyDist: options.copyDist
    })
  }

  assertElectronDistUsable(localDistPath, electronVersion, platformPath)

  const acquireLock = options.acquireLock ?? acquireDefaultLock
  const release = await acquireLock(sharedDistPath, {
    realpath: false,
    lockfilePath: `${sharedDistPath}.lock`,
    stale: 300_000,
    update: 10_000,
    retries: { retries: 120, factor: 1, minTimeout: 500, maxTimeout: 500 }
  })

  try {
    if (pathExists(sharedDistPath)) {
      assertSharedDistPath(sharedDistPath)
      assertElectronDistUsable(sharedDistPath, electronVersion, platformPath)
    } else {
      publishSharedDist(realpathSync(localDistPath), sharedDistPath, {
        copy: options.copyDist ?? copyElectronDist,
        uuid: options.uuid ?? randomUUID
      })
      assertElectronDistUsable(sharedDistPath, electronVersion, platformPath)
    }

    replaceWithDirectoryLink(localDistPath, sharedDistPath, {
      platform: options.platform ?? process.platform,
      linkDirectory: options.linkDirectory
    })
  } finally {
    await release()
  }

  return { electronVersion, localDistPath, sharedDistPath, targetArch, targetPlatform }
}

function acquireDefaultLock(targetPath, options) {
  return require('proper-lockfile').lock(targetPath, options)
}

export function prepareElectronDistForInstall(options = {}) {
  const platform = options.platform ?? process.platform
  const repoRoot = options.repoRoot ?? defaultRepoRoot
  const electronPackageDir =
    options.electronPackageDir ?? path.join(repoRoot, 'node_modules', 'electron')
  const localDistPath = path.join(electronPackageDir, 'dist')
  if (platform !== 'darwin') {
    return { detached: false, reason: 'platform', localDistPath }
  }

  if (!isSymlink(localDistPath)) {
    return { detached: false, reason: 'not-linked', localDistPath }
  }

  let gitCommonDir = options.gitCommonDir
  if (!gitCommonDir) {
    try {
      gitCommonDir = resolveGitCommonDir(repoRoot, options.execFile ?? execFileSync)
    } catch {
      return { detached: false, reason: 'not-a-git-worktree', localDistPath }
    }
  }
  const cacheRoot = path.join(gitCommonDir, 'orca-cache', 'electron')
  const targetPath = getOwnedSharedDistTarget(localDistPath, cacheRoot)
  if (targetPath === null) {
    return { detached: false, reason: 'foreign-link', localDistPath }
  }

  // A missing cache cannot be copied back. Removing only the link lets the
  // installer create a fresh local dist instead of writing through the link.
  if (!pathExists(targetPath)) {
    rmSync(localDistPath, { force: true })
    return { detached: true, copied: false, reason: 'missing-cache', localDistPath }
  }

  const stagePath = `${localDistPath}.orca-detach-${process.pid}-${randomUUID()}`
  const backupPath = `${localDistPath}.orca-linked-${process.pid}-${randomUUID()}`
  try {
    ;(options.copyDist ?? copyElectronDist)(targetPath, stagePath)
    renameSync(localDistPath, backupPath)
    try {
      renameSync(stagePath, localDistPath)
    } catch (publishError) {
      try {
        renameSync(backupPath, localDistPath)
      } catch (rollbackError) {
        throw new AggregateError(
          [publishError, rollbackError],
          `Could not restore Electron dist at ${localDistPath}`
        )
      }
      throw publishError
    }
    rmSync(backupPath, { force: true })
    return { detached: true, copied: true, reason: 'owned-link', localDistPath }
  } catch (error) {
    // Cleanup is best effort; the install gate below decides whether the path is safe.
    try {
      rmSync(stagePath, { recursive: true, force: true })
    } catch {}
    // Never leave an owned symlink for an installer to follow after a failed
    // detach. The next install will repopulate this path normally.
    if (isSymlink(localDistPath)) {
      try {
        rmSync(localDistPath, { force: true })
      } catch {}
    }
    try {
      rmSync(backupPath, { recursive: true, force: true })
    } catch {}
    if (isSymlink(localDistPath)) {
      throw new AggregateError([error], `Could not safely detach Electron dist at ${localDistPath}`)
    }
    throw error
  }
}

export function resolveGitCommonDir(repoRoot, execFile = execFileSync) {
  const rawPath = execFile('git', ['-C', repoRoot, 'rev-parse', '--git-common-dir'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore']
  }).trim()
  if (!rawPath) {
    throw new Error('Git returned an empty common directory')
  }
  return path.resolve(repoRoot, rawPath)
}

export function getElectronTargetPlatform(env = process.env) {
  return env.ELECTRON_INSTALL_PLATFORM || env.npm_config_platform || process.platform
}

export function getElectronTargetArch(_targetPlatform, env = process.env) {
  const configuredArch = env.ELECTRON_INSTALL_ARCH || env.npm_config_arch
  if (configuredArch) {
    return configuredArch
  }
  // Match install-electron-package-binary.mjs exactly. Under Rosetta,
  // process.arch is x64 and Electron downloads the x64 artifact; keying it as
  // arm64 would let native and translated processes reuse incompatible bytes.
  return process.arch
}

export function getElectronPlatformPath(targetPlatform) {
  switch (targetPlatform) {
    case 'darwin':
    case 'mas':
      return path.join('Electron.app', 'Contents', 'MacOS', 'Electron')
    case 'freebsd':
    case 'openbsd':
    case 'linux':
      return 'electron'
    case 'win32':
      return 'electron.exe'
    default:
      throw new Error(`Electron builds are not available on platform: ${targetPlatform}`)
  }
}

function createCacheKey(version, targetPlatform, targetArch) {
  const identity = `${version}\0${targetPlatform}\0${targetArch}`
  const digest = createHash('sha256').update(identity).digest('hex').slice(0, 12)
  const label = `${version}-${targetPlatform}-${targetArch}`
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .slice(0, 80)
  return `${label}-${digest}`
}

function assertElectronDistUsable(distPath, version, platformPath) {
  const installedVersion = readFileSync(path.join(distPath, 'version'), 'utf8')
    .trim()
    .replace(/^v/, '')
  if (installedVersion !== version || !existsSync(path.join(distPath, platformPath))) {
    throw new Error(`Electron ${version} is incomplete at ${distPath}`)
  }
}

function assertSharedDistPath(distPath) {
  const stat = lstatSync(distPath)
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Electron shared dist is not an owned directory: ${distPath}`)
  }
}

function publishSharedDist(sourcePath, sharedDistPath, { copy, uuid }) {
  const stagePath = `${sharedDistPath}.staging-${process.pid}-${uuid()}`
  try {
    copy(sourcePath, stagePath)
    renameSync(stagePath, sharedDistPath)
  } finally {
    rmSync(stagePath, { recursive: true, force: true })
  }
}

export function copyElectronDist(sourcePath, destinationPath, options = {}) {
  const platform = options.platform ?? process.platform
  const clone =
    options.clone ??
    ((source, destination) => {
      execFileSync('/bin/cp', ['-c', '-R', '-P', source, destination], {
        stdio: 'ignore'
      })
    })
  const copy = options.copy ?? copyElectronDistNormally
  const removePartial =
    options.removePartial ??
    ((destination) => {
      rmSync(destination, { recursive: true, force: true })
    })

  if (platform === 'darwin') {
    try {
      clone(sourcePath, destinationPath)
      return
    } catch (cloneError) {
      // cp can leave a partial tree when clonefile is unsupported halfway through.
      try {
        removePartial(destinationPath)
      } catch (cleanupError) {
        throw new AggregateError(
          [cloneError, cleanupError],
          `Could not clean the partial Electron dist clone at ${destinationPath}`
        )
      }
    }
  }

  copy(sourcePath, destinationPath)
}

function copyElectronDistNormally(sourcePath, destinationPath) {
  cpSync(sourcePath, destinationPath, {
    recursive: true,
    dereference: false,
    preserveTimestamps: true,
    verbatimSymlinks: true
  })
}

function isSymlink(targetPath) {
  try {
    return lstatSync(targetPath).isSymbolicLink()
  } catch {
    return false
  }
}

function getOwnedSharedDistTarget(localDistPath, cacheRoot) {
  if (!isSymlink(localDistPath)) {
    return undefined
  }
  let linkTarget
  try {
    linkTarget = readlinkSync(localDistPath)
  } catch {
    return null
  }
  const resolvedTarget = path.resolve(path.dirname(localDistPath), linkTarget)
  const resolvedCacheRoot = path.resolve(cacheRoot)
  const relative = path.relative(resolvedCacheRoot, resolvedTarget)
  if (!isDirectCacheEntry(relative)) {
    return null
  }
  // Cache entries are real directories created by this script. Reject a direct
  // child that redirects elsewhere, including through a nested symlink.
  try {
    if (lstatSync(resolvedTarget).isSymbolicLink()) {
      return null
    }
    const canonicalRelative = path.relative(
      realpathSync(resolvedCacheRoot),
      realpathSync(resolvedTarget)
    )
    if (!isDirectCacheEntry(canonicalRelative)) {
      return null
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      return null
    }
    // A dangling cache entry is still safe to detach: its immediate parent is
    // constrained lexically above, and no install can write through a removed link.
  }
  return resolvedTarget
}

function isDirectCacheEntry(relativePath) {
  return (
    Boolean(relativePath) &&
    !relativePath.startsWith('..') &&
    !path.isAbsolute(relativePath) &&
    !relativePath.includes(path.sep)
  )
}

function replaceWithDirectoryLink(localPath, sharedPath, options) {
  if (pathsResolveToSameLocation(localPath, sharedPath)) {
    return
  }

  const backupPath = `${localPath}.orca-unshared-${process.pid}-${randomUUID()}`
  const hadLocalPath = pathExists(localPath)
  if (hadLocalPath) {
    renameSync(localPath, backupPath)
  }

  try {
    const linkDirectory = options.linkDirectory ?? createDirectoryLink
    linkDirectory(sharedPath, localPath, options.platform)
    if (!pathsResolveToSameLocation(localPath, sharedPath)) {
      throw new Error(`Electron shared-directory link did not resolve to ${sharedPath}`)
    }
  } catch (linkError) {
    rmSync(localPath, { recursive: true, force: true })
    if (hadLocalPath) {
      try {
        renameSync(backupPath, localPath)
      } catch (rollbackError) {
        throw new AggregateError(
          [linkError, rollbackError],
          `Could not link or restore Electron dist at ${localPath}`
        )
      }
    }
    throw linkError
  }

  rmSync(backupPath, { recursive: true, force: true })
}

export function createDirectoryLink(targetPath, linkPath, platform, create = symlinkSync) {
  const types = platform === 'win32' ? ['junction', 'dir'] : ['dir']
  let lastError
  for (const type of types) {
    try {
      create(targetPath, linkPath, type)
      return
    } catch (error) {
      lastError = error
    }
  }
  throw lastError
}

function pathsResolveToSameLocation(firstPath, secondPath) {
  try {
    return realpathSync(firstPath) === realpathSync(secondPath)
  } catch {
    return false
  }
}

function pathExists(targetPath) {
  try {
    lstatSync(targetPath)
    return true
  } catch {
    return false
  }
}

export async function runShareMain(options = {}) {
  const share = options.share ?? shareDevElectronDist
  const logger = options.logger ?? console
  const env = options.env ?? process.env
  if ((options.platform ?? process.platform) !== 'darwin' || isCiEnvironment(env)) {
    return null
  }
  try {
    const result = await share()
    logger.log(
      `[electron-share] Linked Electron ${result.electronVersion} to ${result.sharedDistPath}`
    )
    return result
  } catch (error) {
    // This repository-only optimization must never turn a usable install into a failed setup.
    logger.warn(
      `[electron-share] Keeping this worktree's Electron copy: ${error instanceof Error ? error.message : String(error)}`
    )
    return null
  }
}

function isCiEnvironment(env) {
  return env.CI === '1' || env.CI === 'true'
}

export function runPrepareInstallMain(options = {}) {
  const prepare = options.prepare ?? prepareElectronDistForInstall
  const logger = options.logger ?? console
  const defaultLocalDistPath =
    options.localDistPath ?? path.join(defaultRepoRoot, 'node_modules', 'electron', 'dist')

  try {
    const result = prepare()
    const localDistPath = result?.localDistPath ?? defaultLocalDistPath
    // The guard is intentionally inert off macOS and outside Git worktrees.
    // Keep folder workspaces and non-macOS installs byte-for-byte compatible.
    if (result?.reason === 'platform' || result?.reason === 'not-a-git-worktree') {
      return 0
    }
    // A link not created by this tool is outside our ownership boundary. Do not
    // modify it, but fail closed: Electron's installer must never write through
    // an unresolved symlink into user-managed or redirected state.
    if (result?.reason === 'foreign-link') {
      logger.warn?.(
        `[electron-share] Refusing to run Electron install through non-Orca dist link at ${localDistPath}`
      )
      return isInstallPathSafe(localDistPath) ? 0 : 1
    }
    if (!isInstallPathSafe(localDistPath)) {
      logger.error?.(
        `[electron-share] Refusing to run Electron install while a shared dist link remains at ${localDistPath}`
      )
      return 1
    }
    if (result?.detached) {
      logger.log(`[electron-share] Detached shared Electron dist (${result.reason})`)
    }
    return 0
  } catch (error) {
    // A failed copy can still be fail-open only after the link is definitely gone;
    // otherwise Electron's installer could write through it into shared state.
    if (!isInstallPathSafe(defaultLocalDistPath)) {
      logger.error?.(
        `[electron-share] Cannot safely continue Electron install; shared dist link remains at ${defaultLocalDistPath}`
      )
      return 1
    }
    logger.warn(
      `[electron-share] Could not detach shared Electron dist before install: ${error instanceof Error ? error.message : String(error)}`
    )
    return 0
  }
}

function isInstallPathSafe(targetPath) {
  try {
    return !lstatSync(targetPath).isSymbolicLink()
  } catch (error) {
    return error?.code === 'ENOENT'
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  if (process.argv.includes(PREPARE_INSTALL_FLAG)) {
    process.exitCode = runPrepareInstallMain()
  } else {
    await runShareMain()
  }
}
