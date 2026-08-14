import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  resetLoginShellEnvironmentCacheForTests,
  resolveLoginShellEnvironment
} from './login-shell-environment'

const originalHome = process.env.HOME
const originalZdotdir = process.env.ZDOTDIR
const SHELL_ONLY_VARIABLE = 'ORCA_TEST_LOGIN_SHELL_ONLY'
const originalShellOnlyValue = process.env[SHELL_ONLY_VARIABLE]
let testHome: string | null = null

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

  it.runIf(process.platform !== 'win32')(
    'captures a profile export missing from the parent process',
    async () => {
      testHome = await mkdtemp(join(tmpdir(), 'orca-login-shell-env-'))
      await writeFile(join(testHome, '.zshenv'), `export ${SHELL_ONLY_VARIABLE}=shell-only\n`)
      process.env.HOME = testHome
      process.env.ZDOTDIR = testHome
      delete process.env[SHELL_ONLY_VARIABLE]

      const environment = await resolveLoginShellEnvironment({
        shellOverride: '/bin/zsh',
        force: true
      })
      expect(environment[SHELL_ONLY_VARIABLE]).toBe('shell-only')
    }
  )
})
