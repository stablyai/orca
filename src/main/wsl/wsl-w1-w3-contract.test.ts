import { describe, expect, it, vi, beforeEach } from 'vitest'

const runProcessMock = vi.hoisted(() => vi.fn())
vi.mock('@orca/process-host', () => ({ runProcess: runProcessMock }))
vi.mock('./wsl-executable-path', () => ({
  resolveWslExecutablePath: () => 'C:\\Windows\\System32\\wsl.exe'
}))

import { runWslProcess } from './wsl-runner'
import {
  invalidateWslGuestEnvironment,
  seedWslGuestEnvironmentForTests
} from './wsl-guest-environment'

/** W1 spawn, W2 Windows ownership and W3 WSL runner compose one contract; keep regressions together across all three layers. */
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
    // Bare executable resolution is vulnerable to Group Policy/stripped Electron PATH (#15749).
    await runWslProcess({ loginPath: 'preferred', distro: 'Ubuntu', program: '/bin/true' })
    expect(spawnSpec().program).toBe('C:\\Windows\\System32\\wsl.exe')
  })

  it('passes argv as an array, never a command string', async () => {
    // Pass argv rather than return quoting responsibility to callers.
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
    // Assert the wsl.exe separator position; later -- belongs to the guest shell.
    const separator = argv.findIndex((a) => a === '--' || a === '--exec')
    expect(argv[separator]).toBe('--exec')
  })

  it('keeps a script byte-identical instead of encoding it', async () => {
    // --exec preserves exact script argv and stdin without base64/eval quote repair (#14292).
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
    // #14288: blocking profiles must not consume the command timeout.
    await runWslProcess({ loginPath: 'preferred', distro: 'Ubuntu', program: 'codex' })
    expect(JSON.stringify(spawnSpec().args)).not.toContain('_orca_wsl_shell')
  })

  it('applies the user login PATH even with no shell in the loop', async () => {
    // Keep nvm-installed tools visible through login PATH (#9725/#7563/#8366).
    await runWslProcess({ loginPath: 'preferred', distro: 'Ubuntu', program: 'codex' })
    expect(spawnSpec().args).toContain('PATH=/home/u/.nvm/bin:/usr/bin')
  })
})

describe('failure modes stay distinguishable', () => {
  it('a non-zero exit is data, not an exception', async () => {
    // Nonzero process exits resolve; callers must receive the code.
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
    const result = await runWslProcess({
      loginPath: 'preferred',
      distro: 'Ubuntu',
      program: 'codex'
    })
    expect(result.environmentResolved).toBe(false)
  })
})
