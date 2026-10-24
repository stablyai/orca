import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  parsePosixEnvironment,
  resetLoginShellEnvironmentCacheForTests,
  resolveLoginShellEnvironment,
  shellProbe,
  WIN32_PATH_START_MARKER,
  WIN32_PATH_END_MARKER
} from './login-shell-environment'

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

  it('converts Git Bash POSIX PATH to Win32 semicolon-delimited PATH with cygpath trailer', () => {
    const rawOutput = Buffer.concat([
      Buffer.from(`\0__ORCA_LOGIN_SHELL_ENV_START__\0`),
      Buffer.from('USER=duyen\0PATH=/c/Users/duyen/AppData/Local/agy/bin:/usr/bin\0'),
      Buffer.from(`\0__ORCA_LOGIN_SHELL_ENV_END__\0`),
      Buffer.from(`\0${WIN32_PATH_START_MARKER}\0`),
      Buffer.from('C:\\Users\\duyen\\AppData\\Local\\agy\\bin;C:\\Program Files\\Git\\usr\\bin'),
      Buffer.from(`\0${WIN32_PATH_END_MARKER}\0`)
    ])
    const env = parsePosixEnvironment(rawOutput, { platform: 'win32' })
    expect(env).not.toBeNull()
    const pathValue = env?.PATH ?? env?.Path
    expect(pathValue).toBe(
      'C:\\Users\\duyen\\AppData\\Local\\agy\\bin;C:\\Program Files\\Git\\usr\\bin'
    )
  })

  it('normalizes POSIX drive paths to Win32 when cygpath trailer is absent on Windows', () => {
    const rawOutput = Buffer.concat([
      Buffer.from(`\0__ORCA_LOGIN_SHELL_ENV_START__\0`),
      Buffer.from('USER=duyen\0PATH=/c/Users/duyen/AppData/Local/agy/bin:/d/other/bin\0'),
      Buffer.from(`\0__ORCA_LOGIN_SHELL_ENV_END__\0`)
    ])
    const env = parsePosixEnvironment(rawOutput, { platform: 'win32' })
    expect(env).not.toBeNull()
    const pathValue = env?.PATH ?? env?.Path
    expect(pathValue).toBe('C:\\Users\\duyen\\AppData\\Local\\agy\\bin;D:\\other\\bin')
  })

  it('normalizes POSIX drive paths when PATH starts with a relative entry and cygpath is absent', () => {
    const rawOutput = Buffer.concat([
      Buffer.from(`\0__ORCA_LOGIN_SHELL_ENV_START__\0`),
      Buffer.from('USER=duyen\0PATH=.:/c/Users/duyen/AppData/Local/agy/bin\0'),
      Buffer.from(`\0__ORCA_LOGIN_SHELL_ENV_END__\0`)
    ])
    const env = parsePosixEnvironment(rawOutput, { platform: 'win32' })
    expect(env).not.toBeNull()
    const pathValue = env?.PATH ?? env?.Path
    expect(pathValue).toBe('.;C:\\Users\\duyen\\AppData\\Local\\agy\\bin')
  })

  it('preserves native POSIX PATH on non-Windows platforms', () => {
    const rawOutput = Buffer.concat([
      Buffer.from(`\0__ORCA_LOGIN_SHELL_ENV_START__\0`),
      Buffer.from('USER=duyen\0PATH=/usr/local/bin:/usr/bin\0'),
      Buffer.from(`\0__ORCA_LOGIN_SHELL_ENV_END__\0`)
    ])
    const env = parsePosixEnvironment(rawOutput, { platform: 'linux' })
    expect(env).not.toBeNull()
    expect(env?.PATH).toBe('/usr/local/bin:/usr/bin')
  })

  it('includes cygpath trailer markers in shellProbe for Windows posix shells', () => {
    const probe = shellProbe('C:\\Program Files\\Git\\bin\\bash.exe', { platform: 'win32' })
    expect(probe).toEqual([
      '-ilc',
      expect.stringContaining('cygpath -wp "$PATH"')
    ])
    expect(probe?.[1]).toContain(WIN32_PATH_START_MARKER)
    expect(probe?.[1]).toContain(WIN32_PATH_END_MARKER)
  })
})
