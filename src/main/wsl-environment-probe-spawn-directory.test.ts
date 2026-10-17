import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProcessSpec } from '@orca/process-host/process-spec'

const { execFileMock, runProcessMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  runProcessMock: vi.fn()
}))

vi.mock('node:child_process', () => ({ execFile: execFileMock }))
vi.mock('@orca/process-host', () => ({ runProcess: runProcessMock }))

import {
  getWslGitReadEnvironment,
  resetWslGitReadEnvironmentForTests
} from './git/wsl-git-read-environment'
import { getWslGuestEnvironment, invalidateWslGuestEnvironment } from './wsl/wsl-guest-environment'
import { resetWslInteropSpawnDirectoryCache } from './wsl-interop-spawn-directory'

let root: string
let removedWorktree: string
let appDirectory: string
let profileDirectory: string

function probeOutput(args: readonly string[], cwd: string | undefined): string {
  // Model CreateProcessW rejecting an inherited directory removed through WSL.
  if (!existsSync(cwd ?? removedWorktree)) {
    throw Object.assign(new Error('spawn wsl.exe ENOENT'), { code: 'ENOENT' })
  }
  const script = args.at(-1) ?? ''
  const begin = (/__ORCA_WSL_CAPTURE_BEGIN_ [a-z0-9]+__/.exec(script)?.[0] ?? '').replace(' ', '')
  const end = (/__ORCA_WSL_CAPTURE_END_ [a-z0-9]+__/.exec(script)?.[0] ?? '').replace(' ', '')
  const fields = script.includes('_orca_git_path')
    ? ['/usr/bin', '/usr/bin/git', '/home/u']
    : ['/usr/bin', '/home/u', '/usr/bin/env']
  return `${begin}${fields.join('\0')}${end}`
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-wsl-environment-cwd-'))
  removedWorktree = join(root, 'worktree')
  appDirectory = join(root, 'app')
  profileDirectory = join(root, 'profile')
  for (const directory of [removedWorktree, appDirectory, profileDirectory]) {
    mkdirSync(directory)
  }
  rmSync(removedWorktree, { recursive: true })
  vi.stubEnv('ORCA_USER_DATA_PATH', appDirectory)
  vi.stubEnv('USERPROFILE', profileDirectory)
  resetWslInteropSpawnDirectoryCache()
  resetWslGitReadEnvironmentForTests()
  invalidateWslGuestEnvironment(undefined, true)
  execFileMock.mockReset()
  runProcessMock.mockReset()
  execFileMock.mockImplementation(
    (
      _program: string,
      args: string[],
      options: { cwd?: string },
      callback: (error: unknown, stdout: string, stderr: string) => void
    ) => {
      try {
        const stdout = probeOutput(args, options.cwd)
        queueMicrotask(() => callback(null, stdout, ''))
      } catch (error) {
        queueMicrotask(() => callback(error, '', ''))
      }
    }
  )
  runProcessMock.mockImplementation(async (spec: ProcessSpec) => ({
    code: 0,
    signal: null,
    stdout: probeOutput(spec.args ?? [], spec.cwd),
    stderr: '',
    timedOut: false
  }))
})

afterEach(() => {
  vi.unstubAllEnvs()
  resetWslInteropSpawnDirectoryCache()
  resetWslGitReadEnvironmentForTests()
  invalidateWslGuestEnvironment(undefined, true)
  rmSync(root, { recursive: true, force: true })
})

describe('WSL environment probes after the launch worktree is removed', () => {
  it.each([
    ['Git', getWslGitReadEnvironment, resetWslGitReadEnvironmentForTests, execFileMock],
    ['guest', getWslGuestEnvironment, () => invalidateWslGuestEnvironment('Ubuntu'), runProcessMock]
  ] as const)(
    'keeps the %s environment reusable and revalidates its spawn directory',
    async (_label, getEnvironment, invalidate, spawnMock) => {
      const environment = await getEnvironment('Ubuntu')
      expect(environment).toMatchObject({ path: '/usr/bin', home: '/home/u' })
      expect(await getEnvironment('Ubuntu')).toBe(environment)
      expect(spawnMock).toHaveBeenCalledTimes(1)

      rmSync(appDirectory, { recursive: true })
      invalidate()
      await expect(getEnvironment('Ubuntu')).resolves.toEqual(environment)
      expect(spawnMock).toHaveBeenCalledTimes(2)
    }
  )
})
