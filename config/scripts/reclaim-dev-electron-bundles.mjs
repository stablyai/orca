#!/usr/bin/env node

// Removes idle `out/electron-dev` bundles across every worktree of a repository.
//
// The dev runner already prunes these, but only within the worktree it is starting and only when
// that worktree holds more than one bundle -- and a worktree almost always holds exactly one. So
// nothing ever reclaims a bundle belonging to a worktree you are not currently running, and one
// ~275MB copy per branch accumulates indefinitely.
//
// Bundles are pure build output: `pnpm dev` rebuilds one on demand, and since the Electron dist is
// now shared, rebuilding is cheap.

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'
import {
  DEV_BUNDLE_MARKER_FILENAME,
  getDevBundleProcessTable,
  selectStaleDevBundleDirs
} from './dev-electron-bundle-cache.mjs'

const apply = process.argv.includes('--apply')
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

  const bundles = listWorktrees(repoRoot).flatMap((worktree) => collectDevBundles(worktree))
  // currentDir is null on purpose: unlike the dev runner, this sweep is not about to launch anything,
  // so the only thing protecting a bundle is a live process or an in-flight build.
  const stale = selectStaleDevBundleDirs({
    bundles,
    currentDir: null,
    processTable,
    nowMs: Date.now()
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
      rmSync(dir, { recursive: true, force: true })
      reclaimed += size
      removed += 1
      console.log(`removed  ${dir}  ${(size / 1024 ** 3).toFixed(2)} GiB`)
    } catch (error) {
      console.warn(`skip  ${dir}  (${error instanceof Error ? error.message : String(error)})`)
    }
  }

  const inUse = bundles.length - stale.length
  console.log(
    `\n${apply ? 'Removed' : 'Would remove'} ${removed} bundle(s); ` +
      `${apply ? 'reclaimed' : 'reclaimable'} ~${(reclaimed / 1024 ** 3).toFixed(2)} GiB` +
      `${inUse > 0 ? `; left ${inUse} in use or still building` : ''}` +
      `${apply ? '' : '\nRe-run with --apply to do it.'}`
  )
}

// Guarded so importing this module for tests does not sweep the whole repository.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  main()
}
