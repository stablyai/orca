// OLD and NEW app builds for the fleet gate: refs resolved (fetched from origin if needed), built once per commit in e2e mode.
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { lockCacheEntry, tryLockCacheEntry } from './fleet-gate-cache-lock.mjs'

export const CACHE_ROOT =
  process.env.ORCA_FLEET_GATE_CACHE ?? path.join(os.homedir(), '.cache', 'orca-fleet-gate')
const KEEP_BUILDS = 4

export const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
const gitOptional = (cwd, args) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  return result.status === 0 ? result.stdout.trim() : ''
}

/** A ref that isn't local yet (a just-pushed release tag or branch) is fetched from origin once. */
export function resolveCommit(repoRoot, ref) {
  const local = gitOptional(repoRoot, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
  if (local) {
    return local
  }
  const asTag = spawnSync('git', ['fetch', '--quiet', 'origin', 'tag', ref], { cwd: repoRoot })
  let fetched = ''
  if (asTag.status === 0) {
    fetched = gitOptional(repoRoot, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
  } else {
    // Into a ref of our own, not FETCH_HEAD, which another fetch in this checkout can overwrite meanwhile.
    const scratch = `refs/fleet-gate/fetch-${String(process.pid)}-${String(Date.now())}`
    if (
      spawnSync('git', ['fetch', '--quiet', 'origin', `${ref}:${scratch}`], { cwd: repoRoot })
        .status === 0
    ) {
      fetched = gitOptional(repoRoot, ['rev-parse', '--verify', '--quiet', `${scratch}^{commit}`])
    }
    spawnSync('git', ['update-ref', '-d', scratch], { cwd: repoRoot })
  }
  if (!fetched) {
    throw new Error(`${ref} doesn't resolve locally or on origin`)
  }
  return fetched
}

function run(command, args, cwd, logFile) {
  const fd = fs.openSync(logFile, 'a')
  const result = spawnSync(command, args, { cwd, stdio: ['ignore', fd, fd], env: process.env })
  fs.closeSync(fd)
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed in ${cwd} (log ${logFile})`)
  }
}

/** One e2e-mode build per commit, cached; a --shared clone, so nothing registers as a worktree of the checkout. */
export function ensureBuild(repoRoot, sha) {
  const buildsDir = path.join(CACHE_ROOT, 'builds')
  const dir = path.join(buildsDir, sha)
  const marker = path.join(dir, '.fleet-gate-built')
  fs.mkdirSync(buildsDir, { recursive: true })
  const unlock = lockCacheEntry(dir)
  try {
    if (fs.existsSync(marker)) {
      fs.utimesSync(marker, new Date(), new Date())
      return dir
    }
    buildInto(repoRoot, sha, dir, marker)
  } finally {
    unlock()
  }
  pruneCache(buildsDir, '.fleet-gate-built', KEEP_BUILDS, new Set([dir]))
  return dir
}

function buildInto(repoRoot, sha, dir, marker) {
  const buildsDir = path.dirname(dir)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(buildsDir, { recursive: true })
  const log = path.join(buildsDir, `${sha}.log`)
  fs.writeFileSync(log, '')
  console.log(`[fleet-gate] building ${sha.slice(0, 12)} (log ${log})`)
  // A PR head or scratch commit may not be local yet; fetch it by id so --old/--new take any pushed commit.
  if (spawnSync('git', ['cat-file', '-e', `${sha}^{commit}`], { cwd: repoRoot }).status !== 0) {
    run('git', ['fetch', '--quiet', 'origin', sha], repoRoot, log)
  }
  run('git', ['clone', '--quiet', '--shared', '--no-checkout', repoRoot, dir], buildsDir, log)
  // A blobless source repo leaves new blobs unfetched; let the clone fetch them from the same origin on checkout.
  const filter = gitOptional(repoRoot, ['config', '--get', 'remote.origin.partialclonefilter'])
  if (filter) {
    run(
      'git',
      ['config', 'remote.origin.url', git(repoRoot, ['remote', 'get-url', 'origin'])],
      dir,
      log
    )
    run('git', ['config', 'remote.origin.promisor', 'true'], dir, log)
    run('git', ['config', 'remote.origin.partialclonefilter', filter], dir, log)
  }
  run('git', ['checkout', '--quiet', '--detach', sha], dir, log)
  if (git(dir, ['status', '--porcelain', '--untracked-files=no']) !== '') {
    throw new Error(`checkout of ${sha.slice(0, 12)} is incomplete in ${dir} (log ${log})`)
  }
  run('pnpm', ['install', '--frozen-lockfile', '--prefer-offline'], dir, log)
  run('pnpm', ['run', 'build:packages'], dir, log)
  run(
    process.execPath,
    ['config/scripts/desktop-build/execution/run-electron-vite-build.mjs', '--mode', 'e2e'],
    dir,
    log
  )
  run('pnpm', ['run', 'ensure:electron-runtime'], dir, log)
  fs.writeFileSync(marker, `${new Date().toISOString()}\n`)
}

// Gate runs on one machine share the cache; never delete what a run started within this window may still use.
const IN_USE_MS = 6 * 60 * 60 * 1000

export function pruneCache(parentDir, markerName, keepCount, keep) {
  const entries = fs
    .readdirSync(parentDir, { withFileTypes: true })
    // Entry dirs are bare commit shas; skip lock, staging and tombstone dirs.
    .filter((entry) => entry.isDirectory() && !entry.name.includes('.'))
    .map((entry) => path.join(parentDir, entry.name))
    .map((dir) => ({
      dir,
      mtime: Math.max(
        fs.statSync(path.join(dir, markerName), { throwIfNoEntry: false })?.mtimeMs ?? 0,
        fs.statSync(dir).mtimeMs
      )
    }))
    .sort((a, b) => b.mtime - a.mtime)
  for (const { dir, mtime } of entries.slice(keepCount)) {
    if (keep.has(dir) || Date.now() - mtime <= IN_USE_MS) {
      continue
    }
    // Delete only under the entry's own lock, after rechecking its age there: a run that takes the lock refreshes
    // the marker first, so an entry claimed after the scan above is skipped here.
    const unlock = tryLockCacheEntry(dir)
    if (!unlock) {
      continue
    }
    try {
      const marker =
        fs.statSync(path.join(dir, markerName), { throwIfNoEntry: false })?.mtimeMs ?? 0
      if (Date.now() - marker > IN_USE_MS) {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    } finally {
      unlock()
    }
  }
}
