import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  resetWslInteropSpawnDirectoryCache,
  resolveWslInteropSpawnCwd
} from './wsl-interop-spawn-directory'

// Regression coverage for #16463 ("Removing the worktree Orca was launched from
// breaks every wsl.exe spawn for the rest of the session"). The WSL command
// builders passed `cwd: undefined` meaning "the directory is inside the
// command", but CreateProcessW reads NULL as "inherit the parent's" — and the
// parent's was a `\\wsl.localhost\...` worktree Linux had just deleted. 1805 of
// 1806 git calls then failed `spawn wsl.exe ENOENT` until the app restarted.

const createdRoots: string[] = []

function makeExistingDirectory(): string {
  const dir = mkdtempSync(join(tmpdir(), 'orca-wsl-spawn-cwd-'))
  createdRoots.push(dir)
  return dir
}

const ENV_KEYS = ['ORCA_USER_DATA_PATH', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH'] as const
const savedEnv = new Map<string, string | undefined>()

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv.set(key, process.env[key])
    delete process.env[key]
  }
  resetWslInteropSpawnDirectoryCache()
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    const saved = savedEnv.get(key)
    if (saved === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = saved
    }
  }
  resetWslInteropSpawnDirectoryCache()
  while (createdRoots.length > 0) {
    rmSync(createdRoots.pop()!, { recursive: true, force: true })
  }
})

describe('resolveWslInteropSpawnCwd', () => {
  it('names the app-owned directory first, so no worktree can be the answer', () => {
    const userData = makeExistingDirectory()
    process.env.ORCA_USER_DATA_PATH = userData
    process.env.USERPROFILE = makeExistingDirectory()

    expect(resolveWslInteropSpawnCwd()).toBe(userData)
  })

  it('skips a candidate that does not resolve instead of naming it', () => {
    process.env.ORCA_USER_DATA_PATH = join(tmpdir(), 'orca-wsl-spawn-cwd-never-created')
    const profile = makeExistingDirectory()
    process.env.USERPROFILE = profile

    expect(resolveWslInteropSpawnCwd()).toBe(profile)
  })

  it('always names some directory rather than letting the spawn inherit one', () => {
    // Why: inheriting is the failure mode. With no configured candidate at all
    // the home directory and system root still stand between a spawn and the
    // parent's cwd.
    expect(resolveWslInteropSpawnCwd()).toEqual(expect.any(String))
  })

  it('re-answers after the directory it memoized goes away mid-session', () => {
    // This is the incident: the chosen directory was valid when the process
    // started and was deleted underneath it hours later. A memo that is never
    // re-validated reproduces the original bug one layer up.
    const doomed = makeExistingDirectory()
    process.env.ORCA_USER_DATA_PATH = doomed
    const survivor = makeExistingDirectory()
    expect(resolveWslInteropSpawnCwd()).toBe(doomed)

    rmSync(doomed, { recursive: true, force: true })
    process.env.ORCA_USER_DATA_PATH = survivor

    expect(resolveWslInteropSpawnCwd()).toBe(survivor)
  })
})
