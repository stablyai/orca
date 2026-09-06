import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import path from 'node:path'
import { makeTreeReadOnly, shareTree } from './space-sharing-copy.mjs'

const IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
// Sibling of path.txt, never inside dist: an install replaces dist wholesale.
const MARKER_FILENAME = '.orca-shared-dist'

/**
 * Where sibling worktrees of one repository keep their shared extracted Electron.
 *
 * Null means "install normally" -- every caller treats a missing entry as "do what you did before".
 */
export function resolveSharedElectronDistEntry(options) {
  const { repoRoot, version, targetPlatform, targetArch } = options
  const env = options.env ?? process.env
  // Packaging jobs get a fresh checkout per run, so a cache only adds a failure mode.
  if (env.CI === '1' || env.CI === 'true') {
    return null
  }
  if (![version, targetPlatform, targetArch].every((part) => IDENTITY_PATTERN.test(part ?? ''))) {
    return null
  }
  let gitCommonDir
  try {
    gitCommonDir = resolveGitCommonDir(repoRoot, options.execFile ?? execFileSync)
  } catch {
    return null // Folder workspace, or no Git on PATH.
  }
  const cacheRoot = path.join(gitCommonDir, 'orca-cache', 'electron')
  return {
    cacheRoot,
    entryPath: path.join(cacheRoot, `${version}-${targetPlatform}-${targetArch}`),
    markerPath: path.join(options.electronPackageDir, MARKER_FILENAME)
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

/** True once this worktree's dist is already a clone of the current cache entry. */
export function hasAdoptedSharedElectronDist(entry) {
  try {
    return readFileSync(entry.markerPath, 'utf8') === path.basename(entry.entryPath)
  } catch {
    return false
  }
}

export function recordAdoptedSharedElectronDist(entry, write) {
  try {
    write(entry.markerPath, path.basename(entry.entryPath))
  } catch {
    // The marker is only an optimization: a missing one costs one extra clone.
  }
}

/**
 * Share a validated cache entry into `stagePath`. Deliberately never falls back to a byte copy --
 * with no storage to share the caller is better off with its normal install, which this must not
 * slow down.
 */
export function shareElectronDistFromCache(entry, stagePath, options) {
  const { version, platformPath } = options
  if (!isUsableElectronDist(entry.entryPath, version, platformPath)) {
    return false
  }
  try {
    ;(options.share ?? shareTree)(entry.entryPath, stagePath)
  } catch {
    return false
  }
  return isUsableElectronDist(stagePath, version, platformPath)
}

/**
 * Publish this worktree's dist as the shared entry, best effort.
 *
 * No lock: staging names are unique and `rename` onto a populated directory fails with ENOTEMPTY,
 * so a concurrent publisher either wins the rename or cleans up its own staging tree. Neither can
 * observe a half-written entry, and a usable entry already in place is never overwritten.
 */
export function publishSharedElectronDist(distPath, entry, options = {}) {
  const { version, platformPath } = options
  const uuid = options.uuid ?? randomUUID
  const canValidate = Boolean(version) && Boolean(platformPath)
  // Without an identity to check against, "unusable" is unknowable -- never discard on a guess.
  if (existsSync(entry.entryPath) && (!canValidate || isUsable(entry, version, platformPath))) {
    return false
  }

  const stagePath = `${entry.entryPath}.staging-${process.pid}-${uuid()}`
  try {
    mkdirSync(entry.cacheRoot, { recursive: true })
    ;(options.share ?? shareTree)(distPath, stagePath)
    // Before publishing, not after: an entry is visible the instant the rename lands, and under
    // hardlink sharing this is the only thing standing between a stray write and every worktree.
    ;(options.protect ?? makeTreeReadOnly)(stagePath)
  } catch {
    rmSync(stagePath, { recursive: true, force: true })
    return false
  }

  return swapInElectronDistEntry(entry, stagePath, {
    canValidate,
    version,
    platformPath,
    uuid,
    rename: options.rename ?? renameSync
  })
}

/**
 * Replace the entry with a staged tree, re-checking first.
 *
 * Sharing the tree above takes seconds, and a sibling worktree can publish a perfectly good entry
 * in that time. Re-validating here, immediately before the destructive rename, keeps us from
 * discarding that entry -- and restoring the quarantine on a failed swap keeps a losing publisher
 * from leaving the cache empty.
 */
function swapInElectronDistEntry(entry, stagePath, options) {
  const { canValidate, version, platformPath, uuid, rename } = options
  let quarantinePath = null
  if (existsSync(entry.entryPath)) {
    // Same rule as before staging: an entry we cannot judge, or one that is good, is never
    // displaced. Both mean another worktree got there first, so keep theirs.
    if (!canValidate || isUsable(entry, version, platformPath)) {
      rmSync(stagePath, { recursive: true, force: true })
      return false
    }
    quarantinePath = `${entry.entryPath}.unusable-${process.pid}-${uuid()}`
    try {
      renameSync(entry.entryPath, quarantinePath)
    } catch {
      rmSync(stagePath, { recursive: true, force: true })
      return false // Another worktree is already replacing it.
    }
  }

  try {
    rename(stagePath, entry.entryPath)
  } catch {
    rmSync(stagePath, { recursive: true, force: true })
    if (quarantinePath !== null) {
      // Put it back rather than leave no entry at all; a bad entry still beats an empty cache,
      // because the next publisher re-validates and replaces it.
      try {
        renameSync(quarantinePath, entry.entryPath)
        return false
      } catch {
        rmSync(quarantinePath, { recursive: true, force: true })
      }
    }
    return false
  }

  if (quarantinePath !== null) {
    rmSync(quarantinePath, { recursive: true, force: true })
  }
  return true
}

function isUsable(entry, version, platformPath) {
  return isUsableElectronDist(entry.entryPath, version, platformPath)
}

export function isUsableElectronDist(distPath, version, platformPath) {
  try {
    if (!lstatSync(distPath).isDirectory()) {
      return false
    }
    const installedVersion = readFileSync(path.join(distPath, 'version'), 'utf8')
      .trim()
      .replace(/^v/, '')
    return installedVersion === version && existsSync(path.join(distPath, platformPath))
  } catch {
    return false
  }
}
