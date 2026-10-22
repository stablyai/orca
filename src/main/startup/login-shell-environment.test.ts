import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as runProcessModule from '@orca/process-host'
import { resolveCommandOnLocalPath } from '../ipc/command-path-resolver'
import {
  resetLoginShellEnvironmentCacheForTests,
  resolveLoginShellEnvironment
} from './login-shell-environment'

const { spawnProcessMock } = vi.hoisted(() => ({
  spawnProcessMock: vi.fn()
}))

vi.mock('@orca/process-host', async (importOriginal) => {
  const real = await importOriginal<typeof runProcessModule>()
  return {
    ...real,
    spawnProcess: (spec: Parameters<typeof real.spawnProcess>[0]) =>
      spawnProcessMock.getMockImplementation() ? spawnProcessMock(spec) : real.spawnProcess(spec)
  }
})

const originalHome = process.env.HOME
const originalZdotdir = process.env.ZDOTDIR
const SHELL_ONLY_VARIABLE = 'ORCA_TEST_LOGIN_SHELL_ONLY'
const originalShellOnlyValue = process.env[SHELL_ONLY_VARIABLE]
let testHome: string | null = null

// Why: this case spawns a REAL login shell, so it can only run against one the
// machine actually has. Hardcoding /bin/zsh made it fail on Linux CI, where zsh
// is not installed — the resolver simply returned the parent env and the
// assertion read `undefined`. Each entry pairs a shell with the profile file an
// interactive login shell of that family sources (bash reads .bash_profile when
// it is a login shell, never .bashrc).
const REAL_SHELL_CANDIDATES = [
  { path: '/bin/zsh', profileFile: '.zshenv' },
  { path: '/bin/bash', profileFile: '.bash_profile' }
] as const

const realShell = REAL_SHELL_CANDIDATES.find((candidate) => existsSync(candidate.path)) ?? null

afterEach(async () => {
  resetLoginShellEnvironmentCacheForTests()
  spawnProcessMock.mockReset()
  if (originalHome === undefined) {
    delete process.env.HOME
  } else {
    process.env.HOME = originalHome
  }
  if (originalZdotdir === undefined) {
    delete process.env.ZDOTDIR
  } else {
    process.env.ZDOTDIR = originalZdotdir
  }
  if (originalShellOnlyValue === undefined) {
    delete process.env[SHELL_ONLY_VARIABLE]
  } else {
    process.env[SHELL_ONLY_VARIABLE] = originalShellOnlyValue
  }
  if (testHome) {
    await rm(testHome, { recursive: true, force: true })
    testHome = null
  }
})

describe('resolveLoginShellEnvironment', () => {
  it('returns variables exported by the profile-loading shell', async () => {
    const spawner = vi.fn(async () => ({
      ...process.env,
      EXAMPLE_GATEWAY_TOKEN: 'shell-exported'
    }))

    await expect(
      resolveLoginShellEnvironment({ shellOverride: '/bin/zsh', spawner })
    ).resolves.toMatchObject({ EXAMPLE_GATEWAY_TOKEN: 'shell-exported' })
  })

  it.runIf(realShell !== null)(
    'captures a profile export missing from the parent process',
    async () => {
      const shell = realShell!
      testHome = await mkdtemp(join(tmpdir(), 'orca-login-shell-env-'))
      await writeFile(
        join(testHome, shell.profileFile),
        `export ${SHELL_ONLY_VARIABLE}=shell-only\n`
      )
      process.env.HOME = testHome
      // zsh reads .zshenv from ZDOTDIR when set; harmless for the bash variant.
      process.env.ZDOTDIR = testHome
      delete process.env[SHELL_ONLY_VARIABLE]

      const environment = await resolveLoginShellEnvironment({
        shellOverride: shell.path,
        startedAfter: Date.now()
      })
      expect(environment[SHELL_ONLY_VARIABLE]).toBe('shell-only')
    }
  )

  it.each(['git-bash', 'C:\\Program Files\\Git\\bin\\bash.exe'])(
    'converts a %s PATH with cygpath so agy.exe resolves on win32',
    async (shell) => {
      const platform = Object.getOwnPropertyDescriptor(process, 'platform')
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
      const bin = await mkdtemp(join(tmpdir(), 'orca-agy-bin-'))
      const cwd = await mkdtemp(join(tmpdir(), 'orca-agy-cwd-'))
      const pathEntry = bin.replaceAll('\\', '/')
      await writeFile(join(bin, 'agy.EXE'), '')
      spawnProcessMock.mockImplementation(() => {
        const stdout = new EventEmitter()
        const child = Object.assign(new EventEmitter(), {
          stdin: Object.assign(new EventEmitter(), { end: () => {} }),
          stdout,
          stderr: Object.assign(new EventEmitter(), { resume: () => {} }),
          kill: () => true
        })
        const body = `PATH=${pathEntry}`
        setImmediate(() => {
          stdout.emit(
            'data',
            Buffer.from(
              `\0__ORCA_LOGIN_SHELL_ENV_START__\0${body}\0\0__ORCA_LOGIN_SHELL_ENV_END__\0`
            )
          )
          child.emit('close', 0)
        })
        return child
      })
      try {
        const environment = await resolveLoginShellEnvironment({
          shellOverride: shell,
          startedAfter: Date.now()
        })
        expect(spawnProcessMock).toHaveBeenCalledWith(
          expect.objectContaining({
            program: shell,
            args: [
              '-ilc',
              expect.stringContaining(
                'PATH="$(cygpath -wp "$PATH" 2>/dev/null || printf \'%s\' "$PATH")" /usr/bin/env -0'
              )
            ]
          })
        )
        await expect(
          resolveCommandOnLocalPath('agy', { platform: 'win32', env: environment, cwd })
        ).resolves.toBe(`${pathEntry}/agy.EXE`)
      } finally {
        if (platform) {
          Object.defineProperty(process, 'platform', platform)
        }
        await rm(bin, { recursive: true, force: true })
        await rm(cwd, { recursive: true, force: true })
      }
    }
  )
})
