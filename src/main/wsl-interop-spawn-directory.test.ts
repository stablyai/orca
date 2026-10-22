import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  resetWslInteropSpawnDirectoryCache,
  resolveWslInteropSpawnCwd
} from './wsl-interop-spawn-directory'

// #16463: an inherited cwd Linux had deleted broke every later `wsl.exe` spawn.
// #29845: naming the profile instead let WSL hold it busy ~60s after Orca exited.

const createdRoots: string[] = []

function makeExistingDirectory(): string {
  const dir = mkdtempSync(join(tmpdir(), 'orca-wsl-spawn-cwd-'))
  createdRoots.push(dir)
  return dir
}

const ENV_KEYS = [
  'ORCA_USER_DATA_PATH',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'SystemRoot',
  'windir',
  'SystemDrive'
] as const
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
  it('names the system root, never the profile or the user folder', () => {
    const systemRoot = makeExistingDirectory()
    process.env.SystemRoot = systemRoot
    process.env.ORCA_USER_DATA_PATH = makeExistingDirectory()
    process.env.USERPROFILE = makeExistingDirectory()

    expect(resolveWslInteropSpawnCwd()).toBe(systemRoot)
  })

  it('never falls back to the profile or user folder when no system directory resolves', () => {
    const profile = makeExistingDirectory()
    const userFolder = makeExistingDirectory()
    process.env.ORCA_USER_DATA_PATH = profile
    process.env.USERPROFILE = userFolder

    expect([profile, userFolder]).not.toContain(resolveWslInteropSpawnCwd())
  })

  it('skips a candidate that does not resolve instead of naming it', () => {
    process.env.SystemRoot = join(tmpdir(), 'orca-wsl-spawn-cwd-never-created')
    const windir = makeExistingDirectory()
    process.env.windir = windir

    expect(resolveWslInteropSpawnCwd()).toBe(windir)
  })

  it('re-answers after the directory it memoized goes away mid-session', () => {
    // A memo that is never re-validated reproduces #16463 one layer up.
    const doomed = makeExistingDirectory()
    process.env.SystemRoot = doomed
    const survivor = makeExistingDirectory()
    expect(resolveWslInteropSpawnCwd()).toBe(doomed)

    rmSync(doomed, { recursive: true, force: true })
    process.env.SystemRoot = survivor

    expect(resolveWslInteropSpawnCwd()).toBe(survivor)
  })
})
