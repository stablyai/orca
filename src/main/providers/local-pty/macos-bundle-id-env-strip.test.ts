import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import type * as NodeFs from 'node:fs'
import type * as ProcessHost from '@orca/process-host'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { runProcessMock } = vi.hoisted(() => ({
  runProcessMock: vi.fn()
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  return {
    ...actual,
    existsSync: (targetPath: Parameters<typeof actual.existsSync>[0]) =>
      targetPath === '/usr/bin/login' ? true : actual.existsSync(targetPath)
  }
})

vi.mock('@orca/process-host', async (importOriginal) => {
  const actual = await importOriginal<typeof ProcessHost>()
  return {
    ...actual,
    runProcess: runProcessMock
  }
})

import {
  createDaemonPtyEnvironment,
  finalizeDaemonPtyEnvironment
} from '../../daemon/pty-subprocess/spawn-environment'
import {
  prepareMacosTccLoginShell,
  wrapShellSpawnForMacosTccAttribution
} from '../shell-launch/macos/tcc-login-shell'
import {
  buildInheritedLocalPtyEnvironment,
  enforceLocalPtySpawnEnvironmentOverrides
} from './local-pty-spawn-environment'

const hasBash = existsSync('/bin/bash')

describe('macOS __CFBundleIdentifier environment stripping (#21768)', () => {
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
  let previousBundleId: string | undefined
  let previousDisableLoginShell: string | undefined

  beforeEach(() => {
    previousBundleId = process.env.__CFBundleIdentifier
    previousDisableLoginShell = process.env.ORCA_DISABLE_MACOS_LOGIN_SHELL
    delete process.env.ORCA_DISABLE_MACOS_LOGIN_SHELL
    runProcessMock.mockReset()
    runProcessMock.mockResolvedValue({
      timedOut: false,
      code: 0,
      stdout: 'ORCA_LOGIN_PREFLIGHT_OK',
      stderr: ''
    })
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', platformDescriptor)
    if (previousBundleId === undefined) {
      delete process.env.__CFBundleIdentifier
    } else {
      process.env.__CFBundleIdentifier = previousBundleId
    }
    if (previousDisableLoginShell === undefined) {
      delete process.env.ORCA_DISABLE_MACOS_LOGIN_SHELL
    } else {
      process.env.ORCA_DISABLE_MACOS_LOGIN_SHELL = previousDisableLoginShell
    }
  })

  it('strips inherited and explicit __CFBundleIdentifier in daemon PTY environments', () => {
    process.env.__CFBundleIdentifier = 'com.stablyai.orca'

    const inherited = createDaemonPtyEnvironment({
      sessionId: 'daemon-bundle-id-inherited',
      cols: 80,
      rows: 24
    })
    expect(inherited.__CFBundleIdentifier).toBeUndefined()

    const created = createDaemonPtyEnvironment({
      sessionId: 'daemon-bundle-id-test',
      cols: 80,
      rows: 24,
      env: { __CFBundleIdentifier: 'com.stablyai.orca.helper' }
    })
    expect(created.__CFBundleIdentifier).toBeUndefined()

    const finalized: Record<string, string> = {
      ...created,
      __CFBundleIdentifier: 'com.stablyai.orca'
    }
    finalizeDaemonPtyEnvironment(finalized, undefined)
    expect(finalized.__CFBundleIdentifier).toBeUndefined()
  })

  it('strips inherited and explicit __CFBundleIdentifier in local PTY environments', () => {
    process.env.__CFBundleIdentifier = 'com.stablyai.orca'

    const fromProcessOnly = buildInheritedLocalPtyEnvironment(undefined)
    expect(fromProcessOnly.__CFBundleIdentifier).toBeUndefined()

    const inherited = buildInheritedLocalPtyEnvironment({
      __CFBundleIdentifier: 'com.stablyai.orca.helper'
    })
    expect(inherited.__CFBundleIdentifier).toBeUndefined()

    const finalized: Record<string, string> = {
      ...inherited,
      __CFBundleIdentifier: 'com.stablyai.orca'
    }
    enforceLocalPtySpawnEnvironmentOverrides({ cols: 80, rows: 24 }, finalized)
    expect(finalized.__CFBundleIdentifier).toBeUndefined()
  })

  it.skipIf(!hasBash)(
    'unsets __CFBundleIdentifier while preserving SHELL and other vars in TCC trampolines',
    async () => {
      Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
      const outcome = await prepareMacosTccLoginShell()
      expect(outcome?.ok).toBe(true)

      const env: NodeJS.ProcessEnv = {
        ...process.env,
        __CFBundleIdentifier: 'com.stablyai.orca',
        ORCA_SENTINEL: 'kept'
      }
      // BASH_ENV runs in the exec'd bash and can replace the SHELL the trampoline just set.
      delete env.BASH_ENV

      const loginWrapped = wrapShellSpawnForMacosTccAttribution(
        '/bin/sh',
        ['-c', 'printf "%s|%s|%s" "${__CFBundleIdentifier-UNSET}" "$SHELL" "$ORCA_SENTINEL"'],
        { SHELL: '/bin/zsh' }
      )
      expect(loginWrapped.file).toBe('/usr/bin/login')
      expect(
        execFileSync(loginWrapped.args[2]!, loginWrapped.args.slice(3), { encoding: 'utf8', env })
      ).toBe('UNSET|/bin/zsh|kept')

      const directWrapped = wrapShellSpawnForMacosTccAttribution(
        '/bin/bash',
        [
          '--noprofile',
          '--rcfile',
          '/dev/null',
          '-c',
          'printf "%s|%s|%s" "${__CFBundleIdentifier-UNSET}" "$SHELL" "$ORCA_SENTINEL"'
        ],
        { SHELL: '/bin/bash' }
      )
      expect(directWrapped.file).toBe('/usr/bin/login')
      expect(
        execFileSync(directWrapped.args[2]!, directWrapped.args.slice(3), { encoding: 'utf8', env })
      ).toBe('UNSET|/bin/bash|kept')
    }
  )
})
