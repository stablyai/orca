import { describe, expect, it, vi, beforeEach } from 'vitest'

const runProcessMock = vi.hoisted(() => vi.fn())
vi.mock('../../shared/child-process/run-process', () => ({ runProcess: runProcessMock }))
vi.mock('./wsl-executable-path', () => ({
  resolveWslExecutablePath: () => 'C:\\Windows\\System32\\wsl.exe'
}))

import { runWslProcess } from './wsl-runner'
import {
  invalidateWslGuestEnvironment,
  seedWslGuestEnvironmentForTests
} from './wsl-guest-environment'

/**
 * End-to-end contract across W1 (one spawn chokepoint), W2 (Windows process
 * ownership) and W3 (one WSL runner).
 *
 * Each assertion here is a bug that reached users. They live together because
 * the failures compose: a WSL call is a Windows spawn is a child process, and
 * W1-W3 each fixed one layer of the same call.
 */
const ENV = { path: '/home/u/.nvm/bin:/usr/bin', home: '/home/u', envBinary: '/usr/bin/env' }

function spawnSpec(): Record<string, unknown> {
  return runProcessMock.mock.calls.at(-1)?.[0] as Record<string, unknown>
}

beforeEach(() => {
  runProcessMock.mockReset()
  runProcessMock.mockResolvedValue({
    code: 0,
    signal: null,
    stdout: '',
    stderr: '',
    timedOut: false
  })
  invalidateWslGuestEnvironment(undefined, true)
  seedWslGuestEnvironmentForTests(undefined, ENV)
  seedWslGuestEnvironmentForTests('Ubuntu', ENV)
})

describe('W1: every WSL call inherits the spawn chokepoint', () => {
  it('resolves wsl.exe absolutely, never by bare name', async () => {
    // Bare-name resolution is what a Group Policy or a stripped Electron PATH
    // hijacks (#15749).
    await runWslProcess({ loginPath: 'preferred', distro: 'Ubuntu', program: '/bin/true' })
    expect(spawnSpec().program).toBe('C:\\Windows\\System32\\wsl.exe')
  })

  it('passes argv as an array, never a command string', async () => {
    // A command string would put quoting back in the caller's hands, which is
    // the entire class W1 removed.
    await runWslProcess({
      loginPath: 'preferred',
      distro: 'Ubuntu',
      program: '/bin/echo',
      args: ['a b']
    })
    expect(Array.isArray(spawnSpec().args)).toBe(true)
    expect(spawnSpec().args).toContain('a b')
  })

  it('always bounds the call', async () => {
    await runWslProcess({ loginPath: 'preferred', distro: 'Ubuntu', program: '/bin/true' })
    expect(spawnSpec().timeoutMs).toBeGreaterThan(0)
  })
})

describe('W3: the five per-call decisions are made once', () => {
  it('never uses the -- separator, which expands $name host-side', async () => {
    await runWslProcess({ loginPath: 'preferred', distro: 'Ubuntu', script: 'echo "$HOME"' })
    const argv = spawnSpec().args as string[]
    // Only wsl.exe's own separator matters. A later `--` belongs to `sh -s --`
    // and is the guest shell's end-of-options, so check the position rather
    // than the presence.
    const separator = argv.findIndex((a) => a === '--' || a === '--exec')
    expect(argv[separator]).toBe('--exec')
  })

  it('keeps a script byte-identical instead of encoding it', async () => {
    // The base64 and eval wrappers existed because a host-side shell re-parsed
    // the quotes (#14292). --exec removes that shell, so the script crosses in
    // argv exactly as written -- no encoding, and stdin stays the command's.
    const script = `case "$x" in a) echo 'it'\\''s fine';; esac`
    await runWslProcess({ loginPath: 'preferred', distro: 'Ubuntu', script })
    expect(spawnSpec().args).toContain(script)
    expect(spawnSpec().input).toBeUndefined()
  })

  it('propagates env only through WSLENV', async () => {
    await runWslProcess({
      loginPath: 'preferred',
      distro: 'Ubuntu',
      program: '/bin/true',
      env: { GITLAB_HOST: 'git.example.com' }
    })
    const env = spawnSpec().env as NodeJS.ProcessEnv
    expect(env.WSLENV).toContain('GITLAB_HOST')
  })

  it('runs no shell on the probe lane, so ~/.profile cannot stall it', async () => {
    // #14288: one blocking line in ~/.profile ate the whole timeout.
    await runWslProcess({ loginPath: 'preferred', distro: 'Ubuntu', program: 'codex' })
    expect(JSON.stringify(spawnSpec().args)).not.toContain('_orca_wsl_shell')
  })

  it('applies the user login PATH even with no shell in the loop', async () => {
    // The other half of the same trade: nvm-installed agents must still be
    // found (#9725, #7563, #8366).
    await runWslProcess({ loginPath: 'preferred', distro: 'Ubuntu', program: 'codex' })
    expect(spawnSpec().args).toContain('PATH=/home/u/.nvm/bin:/usr/bin')
  })
})

describe('failure modes stay distinguishable', () => {
  it('a non-zero exit is data, not an exception', async () => {
    // runProcess resolves on a non-zero exit; every caller must be able to see
    // the code rather than have it thrown past them.
    runProcessMock.mockResolvedValue({
      code: 3,
      signal: null,
      stdout: 'partial',
      stderr: '',
      timedOut: false
    })
    const result = await runWslProcess({
      loginPath: 'preferred',
      distro: 'Ubuntu',
      program: '/bin/false'
    })
    expect(result.code).toBe(3)
    expect(result.timedOut).toBe(false)
  })

  it('a timeout is reported, not disguised as an empty answer', async () => {
    runProcessMock.mockResolvedValue({
      code: null,
      signal: null,
      stdout: '',
      stderr: '',
      timedOut: true
    })
    const result = await runWslProcess({
      loginPath: 'preferred',
      distro: 'Ubuntu',
      program: '/bin/true'
    })
    expect(result.timedOut).toBe(true)
  })

  it('an unresolved login PATH is reported, never fatal', async () => {
    invalidateWslGuestEnvironment(undefined, true)
    runProcessMock.mockResolvedValue({
      code: 1,
      signal: null,
      stdout: '',
      stderr: 'stopped',
      timedOut: false
    })
    // Every knob this runner used to carry existed because this case threw.
    const result = await runWslProcess({
      loginPath: 'preferred',
      distro: 'Ubuntu',
      program: 'codex'
    })
    expect(result.environmentResolved).toBe(false)
  })
})
