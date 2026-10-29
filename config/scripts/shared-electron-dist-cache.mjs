import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { makeTreeReadOnly, shareTree } from './space-sharing-copy.mjs'
import { publishSharedTree, sharedTreeStagingPath } from './shared-tree-publish.mjs'
import { isSharedPackageDir } from './native-build-entry.cjs'

const IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
// Sibling of path.txt, never inside dist: an install replaces dist wholesale.
const MARKER_FILENAME = '.orca-shared-dist'

// Return repository-wide shared Electron location or null for normal install; folder workspaces also use normal install.
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
  // Skip cache under global pnpm store: worktrees already share package and replacing dist would displace running apps.
  if ((options.isSharedPackageDir ?? isSharedPackageDir)(options.electronPackageDir, repoRoot)) {
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

// Share validated entry without byte-copy fallback: when storage cannot be shared, caller’s normal install is preferable.
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

// Publish via unique staging/atomic rename without lock: populated entry blocks racing replacement; usable entry is never overwritten.
export function publishSharedElectronDist(distPath, entry, options = {}) {
  const { version, platformPath } = options
  const uuid = options.uuid ?? randomUUID
  const canValidate = Boolean(version) && Boolean(platformPath)
  // Without an identity to check against, "unusable" is unknowable -- never discard on a guess.
  if (existsSync(entry.entryPath) && (!canValidate || isUsable(entry, version, platformPath))) {
    return false
  }

  const stagePath = sharedTreeStagingPath(entry.entryPath, uuid)
  try {
    mkdirSync(entry.cacheRoot, { recursive: true })
    ;(options.share ?? shareTree)(distPath, stagePath)
    // Protect before publish: rename exposes entry immediately, and hardlink writes would mutate every worktree.
    ;(options.protect ?? makeTreeReadOnly)(stagePath)
  } catch {
    rmSync(stagePath, { recursive: true, force: true })
    return false
  }

  // An entry we cannot judge counts as good: another worktree got there first, so keep theirs.
  return publishSharedTree(stagePath, entry.entryPath, {
    isUsable: () => !canValidate || isUsable(entry, version, platformPath),
    uuid,
    rename: options.rename
  })
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
