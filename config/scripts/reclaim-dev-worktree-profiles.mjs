#!/usr/bin/env node
// Removes per-worktree `pnpm dev` profiles (see dev-instance-isolation.mjs) whose worktree is gone.
import { lstat, readdir, readFile, readlink, realpath, rm } from 'node:fs/promises'
import path from 'node:path'
import {
  getWorktreeDevProfilesRoot,
  readWorktreeProfileMarker,
  sameFilesystemPath,
  WORKTREE_PROFILE_NAME_PATTERN
} from './dev-instance-isolation.mjs'
import { localRepositoryWorktrees } from './local-repository-worktrees.mjs'
import { parseReclaimArguments } from './reclaim-worktree-command.mjs'
import { isProcessAlive, readDaemonPids } from './remote-agent-session-process-cleanup.mjs'

async function exists(filePath) {
  try {
    await lstat(filePath)
    return true
  } catch (error) {
    if (error.code === 'ENOENT') {
      return false
    }
    throw error
  }
}

async function canonical(filePath) {
  try {
    return await realpath(filePath)
  } catch {
    return path.resolve(filePath)
  }
}

/** PIDs that may still hold the profile: the app (Chromium's lock), its runtime, and terminal daemons. */
async function profileOwnerPids(userDataPath) {
  const pids = [...readDaemonPids(userDataPath)]
  try {
    // POSIX Chromium writes SingletonLock as a symlink to `<host>-<pid>`.
    const match = /-(\d+)$/.exec(await readlink(path.join(userDataPath, 'SingletonLock')))
    if (match) {
      pids.push(Number(match[1]))
    }
  } catch {}
  try {
    const runtime = JSON.parse(await readFile(path.join(userDataPath, 'orca-runtime.json'), 'utf8'))
    if (Number.isInteger(runtime?.pid)) {
      pids.push(runtime.pid)
    }
  } catch {}
  return pids
}

export async function reclaimDevWorktreeProfiles({
  repoRoot = process.cwd(),
  apply = false,
  excludeWorktree,
  profilesRoot = getWorktreeDevProfilesRoot(),
  repository,
  isAlive = isProcessAlive,
  report = console.log
} = {}) {
  const { commonDirectory, worktrees } = repository ?? (await localRepositoryWorktrees(repoRoot))
  const liveWorktrees = await Promise.all(worktrees.map(canonical))
  const result = { entries: 0, protected: 0 }
  let names
  try {
    names = await readdir(profilesRoot)
  } catch (error) {
    if (error.code === 'ENOENT') {
      return result
    }
    throw error
  }
  for (const name of names) {
    const profileDir = path.join(profilesRoot, name)
    if (!WORKTREE_PROFILE_NAME_PATTERN.test(name) || !(await lstat(profileDir)).isDirectory()) {
      continue
    }
    const marker = readWorktreeProfileMarker(profileDir)
    // Profiles from other repositories belong to their own repository's cleanup.
    if (
      !marker?.gitCommonDir ||
      !sameFilesystemPath(await canonical(marker.gitCommonDir), commonDirectory)
    ) {
      continue
    }
    if (
      (excludeWorktree && sameFilesystemPath(marker.repoRoot, excludeWorktree)) ||
      liveWorktrees.some((worktree) => sameFilesystemPath(worktree, marker.repoRoot)) ||
      (await exists(marker.repoRoot))
    ) {
      continue
    }
    if ((await profileOwnerPids(profileDir)).some((pid) => isAlive(pid))) {
      result.protected += 1
      report(`retained dev profile ${JSON.stringify(profileDir)} (a process still uses it)`)
      continue
    }
    if (apply) {
      try {
        await rm(profileDir, { recursive: true, force: true })
      } catch (error) {
        // Windows keeps a running profile's lock files open, so removal fails instead of racing.
        result.protected += 1
        report(`retained dev profile ${JSON.stringify(profileDir)} (${error.message})`)
        continue
      }
    }
    result.entries += 1
    report(
      `${apply ? 'removed' : 'would remove'} dev profile ${JSON.stringify(profileDir)} for removed worktree ${JSON.stringify(marker.repoRoot)}`
    )
  }
  report(
    `${apply ? 'Removed' : 'Would remove'} ${result.entries} dev profile(s) of removed worktrees; retained ${result.protected} in use.`
  )
  return result
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const options = parseReclaimArguments(process.argv.slice(2))
  if (options.help) {
    console.log(
      'Usage: node config/scripts/reclaim-dev-worktree-profiles.mjs [--apply] [--repo DIRECTORY]'
    )
  } else {
    reclaimDevWorktreeProfiles(options).catch((error) => {
      console.error(error.message)
      process.exitCode = 1
    })
  }
}
