import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  resetLoginShellEnvironmentCacheForTests,
  resolveLoginShellEnvironment
} from './login-shell-environment'

const originalHome = process.env.HOME
const originalZdotdir = process.env.ZDOTDIR
const SHELL_ONLY_VARIABLE = 'ORCA_TEST_LOGIN_SHELL_ONLY'
const originalShellOnlyValue = process.env[SHELL_ONLY_VARIABLE]
let testHome: string | null = null

// Choose an installed real shell with its login profile: Linux CI may lack zsh, and login bash reads .bash_profile rather than .bashrc.
const REAL_SHELL_CANDIDATES = [
  { path: '/bin/zsh', profileFile: '.zshenv' },
  { path: '/bin/bash', profileFile: '.bash_profile' }
] as const

const realShell = REAL_SHELL_CANDIDATES.find((candidate) => existsSync(candidate.path)) ?? null

// The pwsh on PATH, as an absolute login-shell path; skipped on Windows and where none is installed.
const realPwsh =
  process.platform === 'win32'
    ? null
    : spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-Command', '[Environment]::ProcessPath'], {
        encoding: 'utf8'
      }).stdout?.trim() || null
const originalXdgConfigHome = process.env.XDG_CONFIG_HOME

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
  if (originalXdgConfigHome === undefined) {
    delete process.env.XDG_CONFIG_HOME
  } else {
    process.env.XDG_CONFIG_HOME = originalXdgConfigHome
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

  it.runIf(realPwsh !== null)(
    'captures a PowerShell profile export when pwsh is the login shell',
    async () => {
      testHome = await mkdtemp(join(tmpdir(), 'orca-login-pwsh-env-'))
      await mkdir(join(testHome, '.config', 'powershell'), { recursive: true })
      await writeFile(
        join(testHome, '.config', 'powershell', 'profile.ps1'),
        `$env:${SHELL_ONLY_VARIABLE} = 'pwsh-profile'\n`
      )
      process.env.HOME = testHome
      delete process.env.XDG_CONFIG_HOME
      delete process.env[SHELL_ONLY_VARIABLE]

      const environment = await resolveLoginShellEnvironment({
        shellOverride: realPwsh!,
        // The cache is reset after each test, so any run started now answers.
        startedAfter: 0,
        // .NET cold start is slow on CI runners.
        timeoutMs: 20_000
      })
      expect(environment[SHELL_ONLY_VARIABLE]).toBe('pwsh-profile')
    },
    30_000
  )
})
