#!/usr/bin/env node

// Sweep idle ~275MB bundles across worktrees: dev runner prunes only its own tree when it has multiple bundles. pnpm dev rebuilds these outputs on demand.

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'
import {
  DEV_BUNDLE_MARKER_FILENAME,
  getDevBundleProcessTable,
  selectStaleDevBundleDirs
} from './dev-electron-bundle-cache.mjs'

const apply = process.argv.includes('--apply')
const minAgeIndex = process.argv.indexOf('--min-age-days')
const minAgeDays = minAgeIndex === -1 ? 0 : Number(process.argv[minAgeIndex + 1])
const excludeIndex = process.argv.indexOf('--exclude-worktree')
const excludeArgument = excludeIndex === -1 ? undefined : process.argv[excludeIndex + 1]
if (excludeIndex !== -1 && (!excludeArgument || excludeArgument.startsWith('-'))) {
  throw new Error('--exclude-worktree requires a directory')
}
const excludeWorktree = excludeArgument ? realpathSync(excludeArgument) : null
const repoRoot = process.argv.includes('--repo')
  ? path.resolve(process.argv[process.argv.indexOf('--repo') + 1])
  : process.cwd()

function listWorktrees(root) {
  const raw = execFileSync('git', ['-C', root, 'worktree', 'list', '--porcelain'], {
    encoding: 'utf8'
  })
  return raw
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length).trim())
}

function canonicalWorktreePath(worktree) {
  try {
    return realpathSync(worktree)
  } catch {
    return path.resolve(worktree)
  }
}

function measure(targetPath) {
  let total = 0
  let entries
  try {
    entries = readdirSync(targetPath, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    const entryPath = path.join(targetPath, entry.name)
    if (entry.isDirectory()) {
      total += measure(entryPath)
    } else if (!entry.isSymbolicLink()) {
      total += statSync(entryPath, { throwIfNoEntry: false })?.size ?? 0
    }
  }
  return total
}

export function collectDevBundles(worktree) {
  const root = path.join(worktree, 'out', 'electron-dev')
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const dir = path.join(root, entry.name)
        return {
          dir,
          hasMarker: existsSync(path.join(dir, DEV_BUNDLE_MARKER_FILENAME)),
          mtimeMs: statSync(dir, { throwIfNoEntry: false })?.mtimeMs ?? 0
        }
      })
  } catch {
    return []
  }
}

function main() {
  if (!Number.isFinite(minAgeDays) || minAgeDays < 0) {
    throw new Error('--min-age-days requires a non-negative number')
  }
  // The patched dev bundle is only built on macOS; elsewhere the dev app runs from dist directly.
  if (process.platform !== 'darwin') {
    console.log('No dev Electron bundles on this platform; nothing to reclaim.')
    return
  }

  const processTable = getDevBundleProcessTable()
  if (processTable === null) {
    // Same rule the dev runner uses: no process table means we cannot prove a bundle is idle.
    console.error('Could not read the process table; refusing to guess which bundles are idle.')
    process.exitCode = 1
    return
  }

  const bundles = listWorktrees(repoRoot)
    .filter((worktree) => canonicalWorktreePath(worktree) !== excludeWorktree)
    .flatMap((worktree) => collectDevBundles(worktree))
  // No launch follows this sweep: currentDir is null so only live process/in-flight build protects a bundle.
  const stale = selectStaleDevBundleDirs({
    bundles,
    currentDir: null,
    processTable,
    nowMs: Date.now(),
    minAgeMs: minAgeDays * 24 * 60 * 60 * 1000
  })

  let reclaimed = 0
  let removed = 0
  for (const dir of stale) {
    const size = measure(dir)
    if (!apply) {
      console.log(`would remove  ${dir}  ${(size / 1024 ** 3).toFixed(2)} GiB`)
      reclaimed += size
      removed += 1
      continue
    }
    try {
      const currentProcessTable = getDevBundleProcessTable()
      if (currentProcessTable === null) {
        throw new Error('Process ownership is unverifiable')
      }
      const currentBundle = collectDevBundles(path.resolve(dir, '..', '..', '..')).find(
        (bundle) => bundle.dir === dir
      )
      if (
        !currentBundle ||
        !selectStaleDevBundleDirs({
          bundles: [currentBundle],
          currentDir: null,
          processTable: currentProcessTable,
          nowMs: Date.now(),
          minAgeMs: minAgeDays * 24 * 60 * 60 * 1000
        }).includes(dir)
      ) {
        continue
      }
      rmSync(dir, { recursive: true, force: true })
      reclaimed += size
      removed += 1
      console.log(`removed  ${dir}  ${(size / 1024 ** 3).toFixed(2)} GiB`)
    } catch (error) {
      console.warn(`skip  ${dir}  (${error instanceof Error ? error.message : String(error)})`)
      process.exitCode = 1
    }
  }

  const inUse = bundles.length - stale.length
  console.log(
    `\n${apply ? 'Removed' : 'Would remove'} ${removed} bundle(s); ` +
      `logical file data ~${(reclaimed / 1024 ** 3).toFixed(2)} GiB (shared blocks affect disk savings)` +
      `${inUse > 0 ? `; retained ${inUse} protected or recent bundle(s)` : ''}` +
      `${apply ? '' : '\nRe-run with --apply to do it.'}`
  )
}

// Guarded so importing this module for tests does not sweep the whole repository.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  main()
}
