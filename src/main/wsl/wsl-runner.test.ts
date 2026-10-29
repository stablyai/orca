import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const runProcessMock = vi.hoisted(() => vi.fn())
vi.mock('@orca/process-host', () => ({ runProcess: runProcessMock }))
vi.mock('../wsl-interop-spawn-directory', () => ({
  resolveWslInteropSpawnCwd: () => 'C:\\Windows'
}))
vi.mock('./wsl-executable-path', () => ({
  resolveWslExecutablePath: () => 'C:\\Windows\\System32\\wsl.exe'
}))

import { runWslProcess } from './wsl-runner'
import {
  invalidateWslGuestEnvironment,
  seedWslGuestEnvironmentForTests
} from './wsl-guest-environment'

const ENVIRONMENT = {
  path: '/home/u/.nvm/bin:/usr/bin',
  home: '/home/u',
  envBinary: '/usr/bin/env'
}

function lastArgv(): string[] {
  return runProcessMock.mock.calls.at(-1)?.[0].args as string[]
}

/** Echo the real fence; empty stdout means the login shell never ran the command, not a successful empty result. */
function fencedEcho(payload = ''): void {
  runProcessMock.mockImplementation(async (spec: { args: string[] }) => {
    const script = spec.args.at(-1) ?? ''
    const begin = (/__ORCA_WSL_CAPTURE_BEGIN_ [a-z0-9]+__/.exec(script)?.[0] ?? '').replace(' ', '')
    const end = (/__ORCA_WSL_CAPTURE_END_ [a-z0-9]+__/.exec(script)?.[0] ?? '').replace(' ', '')
    return {
      environmentResolved: true,
      code: 0,
      signal: null,
      stdout: begin ? `${begin}${payload}${end}` : payload,
      stderr: '',
      timedOut: false
    }
  })
}

beforeEach(() => {
  runProcessMock.mockReset()
  fencedEcho()
  invalidateWslGuestEnvironment(undefined, true)
})

afterEach(() => {
  invalidateWslGuestEnvironment(undefined, true)
})

describe('separator', () => {
  it.each([['none'], ['preferred']] as const)(
    'uses --exec and never -- with loginPath %s',
    async (lane) => {
      // #12964: -- expands $name in every forwarded argument before guest execution; only --exec reliably preserves argv.
      seedWslGuestEnvironmentForTests(undefined, ENVIRONMENT)
      await runWslProcess({ loginPath: lane, program: '/usr/bin/git', args: ['status'] })
      expect(lastArgv()).toContain('--exec')
      expect(lastArgv()).not.toContain('--')
    }
  )

  it('passes the distro before --exec', async () => {
    seedWslGuestEnvironmentForTests('Ubuntu', ENVIRONMENT)
    await runWslProcess({ loginPath: 'preferred', distro: 'Ubuntu', program: '/bin/true' })
    expect(lastArgv().slice(0, 3)).toEqual(['-d', 'Ubuntu', '--exec'])
  })

  it('passes the guest user before --exec', async () => {
    await runWslProcess({ loginPath: 'none', distro: 'Ubuntu', user: 'root', program: '/bin/true' })
    expect(lastArgv().slice(0, 5)).toEqual(['-d', 'Ubuntu', '-u', 'root', '--exec'])
  })
})

describe('probe lane', () => {
  it('runs with the cached login PATH and no shell', async () => {
    // Keep user PATH without repeated blocking login shells (#14288/#9768).
    seedWslGuestEnvironmentForTests(undefined, ENVIRONMENT)
    await runWslProcess({ loginPath: 'preferred', program: 'codex', args: ['--version'] })
    expect(lastArgv()).toEqual([
      '--exec',
      '/usr/bin/env',
      'PATH=/home/u/.nvm/bin:/usr/bin',
      'HOME=/home/u',
      'codex',
      '--version'
    ])
  })

  it('runs anyway and says the PATH is unresolved', async () => {
    // Missing login PATH is result metadata, never a fatal runner error.
    runProcessMock.mockResolvedValue({
      code: 1,
      signal: null,
      stdout: '',
      stderr: 'distro is stopped',
      timedOut: false
    })
    const result = await runWslProcess({ loginPath: 'preferred', program: 'codex' })
    expect(result.environmentResolved).toBe(false)
    expect(lastArgv()).toEqual(['--exec', 'codex'])
  })

  it('reports a resolved environment on the happy path', async () => {
    seedWslGuestEnvironmentForTests(undefined, ENVIRONMENT)
    const result = await runWslProcess({ loginPath: 'preferred', program: 'codex' })
    expect(result.environmentResolved).toBe(true)
  })
})

describe('scripts', () => {
  it('passes a script in argv by default, leaving the command its own stdin', async () => {
    // Piped scripts conflict with commands reading stdin; argv preserves stdin and --exec avoids quote reparsing (#14292).
    seedWslGuestEnvironmentForTests(undefined, ENVIRONMENT)
    const script = `case "$x" in a) echo 'it'\\''s fine';; esac`
    await runWslProcess({ loginPath: 'preferred', script, args: ['/tmp/root'] })
    expect(runProcessMock.mock.calls.at(-1)?.[0].input).toBeUndefined()
    expect(lastArgv()).toEqual([
      '--exec',
      '/usr/bin/env',
      'PATH=/home/u/.nvm/bin:/usr/bin',
      'HOME=/home/u',
      'sh',
      '-c',
      script,
      '--',
      '/tmp/root'
    ])
  })

  it('leaves stdin free so a stdin-reading command cannot truncate the script', async () => {
    // A hook's ssh -T can drain a piped script, silently skipping later commands while bash exits 0.
    seedWslGuestEnvironmentForTests(undefined, ENVIRONMENT)
    await runWslProcess({
      loginPath: 'preferred',
      shell: 'bash',
      script: 'ssh -T git@github.com || true\npnpm install'
    })
    const spec = runProcessMock.mock.calls.at(-1)?.[0]
    expect(spec.input).toBeUndefined()
    expect(spec.args).toContain('ssh -T git@github.com || true\npnpm install')
  })

  it('falls back to stdin for a script too large for a command line', async () => {
    // Unbounded hooks can exceed Windows' command-line cap; stdin degradation is preferable to spawn failure.
    seedWslGuestEnvironmentForTests(undefined, ENVIRONMENT)
    const script = `echo ${'x'.repeat(31_000)}`
    await runWslProcess({ loginPath: 'preferred', shell: 'bash', script })
    const spec = runProcessMock.mock.calls.at(-1)?.[0]
    expect(spec.input).toBe(script)
    expect(lastArgv().slice(-3)).toEqual(['bash', '-s', '--'])
  })

  it('flips to stdin when the login PATH, not the script, is what overflows', async () => {
    // Count injected PATH too or shorter hooks can fail argv while longer hooks succeed through stdin.
    seedWslGuestEnvironmentForTests(undefined, {
      ...ENVIRONMENT,
      path: '/opt/x/bin:'.repeat(2_500)
    })
    // Keep script below the old threshold while combined PATH exceeds the Windows ceiling.
    const script = `echo ${'x'.repeat(7_000)}`
    expect(script.length).toBeLessThan(8_000)
    await runWslProcess({ loginPath: 'preferred', shell: 'bash', script })
    const spec = runProcessMock.mock.calls.at(-1)?.[0]
    expect(spec.input).toBe(script)
    expect(spec.args.join(' ')).not.toContain(script)
  })

  it('charges quoting, so a quote-dense script cannot slip over the real cap', async () => {
    // libuv quoting/backslash escaping expands argv; raw script length undercounts the Windows ceiling.
    seedWslGuestEnvironmentForTests(undefined, ENVIRONMENT)
    const script = '"'.repeat(26_000)
    await runWslProcess({ loginPath: 'preferred', shell: 'bash', script })
    expect(runProcessMock.mock.calls.at(-1)?.[0].input).toBe(script)
  })

  it('keeps an ordinary-sized script in argv', async () => {
    seedWslGuestEnvironmentForTests(undefined, ENVIRONMENT)
    const script = `echo ${'x'.repeat(100)}`
    await runWslProcess({ loginPath: 'preferred', shell: 'bash', script })
    expect(runProcessMock.mock.calls.at(-1)?.[0].input).toBeUndefined()
  })

  it('adds every propagated key so the value actually crosses the boundary', async () => {
    // WSLENV is required to propagate Windows-side values (#12557).
    seedWslGuestEnvironmentForTests(undefined, ENVIRONMENT)
    await runWslProcess({
      loginPath: 'preferred',
      program: '/bin/true',
      env: { GITLAB_HOST: 'git.example.com', GH_TOKEN: 't' }
    })
    const env = runProcessMock.mock.calls.at(-1)?.[0].env as NodeJS.ProcessEnv
    expect(env.GITLAB_HOST).toBe('git.example.com')
    expect(env.WSLENV?.split(':')).toEqual(expect.arrayContaining(['GITLAB_HOST', 'GH_TOKEN']))
  })

  it('always sets WSL_UTF8, even with nothing to propagate', async () => {
    // Always set WSL_UTF8 or surfaced wsl.exe errors contain UTF-16 NULs (#9010).
    seedWslGuestEnvironmentForTests(undefined, ENVIRONMENT)
    await runWslProcess({ loginPath: 'preferred', program: '/bin/true' })
    const env = runProcessMock.mock.calls.at(-1)?.[0].env as NodeJS.ProcessEnv
    expect(env.WSL_UTF8).toBe('1')
  })

  it('adds no WSLENV entry when nothing is propagated', async () => {
    seedWslGuestEnvironmentForTests(undefined, ENVIRONMENT)
    await runWslProcess({ loginPath: 'preferred', program: '/bin/true' })
    const env = runProcessMock.mock.calls.at(-1)?.[0].env as NodeJS.ProcessEnv
    expect(env.WSLENV).toBe(process.env.WSLENV)
  })
})

describe('guest cwd', () => {
  it('cds inside the guest rather than passing a Windows cwd to wsl.exe', async () => {
    seedWslGuestEnvironmentForTests(undefined, ENVIRONMENT)
    await runWslProcess({ loginPath: 'preferred', program: '/usr/bin/git', cwd: '/home/u/repo' })
    // Use stable Windows cwd, never the guest path or a deletable inherited worktree (#16463).
    expect(runProcessMock.mock.calls.at(-1)?.[0].cwd).not.toBe('/home/u/repo')
    expect(runProcessMock.mock.calls.at(-1)?.[0].cwd).toEqual('C:\\Windows')
    expect(lastArgv()).toContain('/home/u/repo')
    expect(lastArgv()).toContain('sh')
  })

  it.each([['C:\\repo'], ['relative/path']])('rejects %s as a guest cwd', async (cwd) => {
    // Reject mistaken Windows cwd instead of hiding it through translation.
    seedWslGuestEnvironmentForTests(undefined, ENVIRONMENT)
    await expect(
      runWslProcess({ loginPath: 'preferred', program: '/bin/true', cwd })
    ).rejects.toThrow(/guest path/)
  })
})

describe('program is a binary, not a shell string', () => {
  it.each([['sh -c echo hi'], ['a; b'], ['a | b'], ['a && b'], ['echo $HOME'], ['a > b']])(
    'rejects %s',
    async (program) => {
      await expect(runWslProcess({ loginPath: 'preferred', program })).rejects.toThrow(
        /single binary/
      )
    }
  )

  it('allows a guest path containing a space', async () => {
    // --exec preserves spaced executable paths as single argv elements.
    seedWslGuestEnvironmentForTests(undefined, ENVIRONMENT)
    await expect(
      runWslProcess({ loginPath: 'preferred', program: '/home/u/my tools/codex' })
    ).resolves.toBeDefined()
  })
})

describe('program is not an assignment', () => {
  it('rejects a name=value program that env would swallow', async () => {
    // name=value after env is another assignment; without a program it prints secrets and exits 0.
    seedWslGuestEnvironmentForTests(undefined, ENVIRONMENT)
    await expect(runWslProcess({ loginPath: 'preferred', program: 'FOO=bar' })).rejects.toThrow(
      /assignment/
    )
  })
})

describe('timeout budget', () => {
  it('leaves the command time after a slow probe', async () => {
    // Probe shares the command's timeout instead of spending an independent 10s first.
    seedWslGuestEnvironmentForTests(undefined, ENVIRONMENT)
    await runWslProcess({ loginPath: 'preferred', program: '/bin/true', timeoutMs: 5_000 })
    const passed = runProcessMock.mock.calls.at(-1)?.[0].timeoutMs as number
    expect(passed).toBeGreaterThan(1_000)
    expect(passed).toBeLessThanOrEqual(5_000)
  })
})

describe('the probe never starves the command', () => {
  it.each([
    [5_000, 2_500],
    [8_000, 4_000],
    [10_000, 6_000]
  ])('leaves a %ims caller at least %ims', async (timeoutMs, floor) => {
    // Run the actual probe (no seed) to prove budget splitting leaves time for the command even after probe failure.
    await runWslProcess({
      loginPath: 'preferred',
      program: '/bin/true',
      timeoutMs
    })
    const probeMs = runProcessMock.mock.calls[0]?.[0].timeoutMs as number
    expect(probeMs).toBeLessThanOrEqual(timeoutMs - floor)
  })
})

describe('script interpreter', () => {
  it('defaults to sh', async () => {
    seedWslGuestEnvironmentForTests(undefined, ENVIRONMENT)
    await runWslProcess({ loginPath: 'preferred', script: 'echo hi' })
    expect(lastArgv()).toContain('sh')
    expect(lastArgv()).not.toContain('bash')
  })

  it('honours an explicit bash request', async () => {
    // Bash-only payloads need explicit bash; silent dash fallback reproduces #14292.
    seedWslGuestEnvironmentForTests(undefined, ENVIRONMENT)
    await runWslProcess({ loginPath: 'preferred', script: 'done < <(find .)', shell: 'bash' })
    expect(lastArgv()).toContain('bash')
    expect(lastArgv()).not.toContain('sh')
  })
})

describe('a script never rides a login shell', () => {
  it('runs the script shell-free even when the distro cannot be probed', async () => {
    // No login-shell fallback: it can consume piped script stdin and report empty success, worse than degraded PATH.
    runProcessMock.mockResolvedValue({
      environmentResolved: true,
      code: 1,
      signal: null,
      stdout: '',
      stderr: 'distro is stopped',
      timedOut: false
    })
    await runWslProcess({ loginPath: 'preferred', script: 'echo hi' })
    expect(lastArgv()).toEqual(['--exec', 'sh', '-c', 'echo hi', '--'])
    expect(runProcessMock.mock.calls.at(-1)?.[0].input).toBeUndefined()
  })
})

describe('WSLENV', () => {
  it('never forwards a path-shaped variable', async () => {
    // WSLENV path translation would replace guest PATH with Windows PATH and break lookup.
    seedWslGuestEnvironmentForTests(undefined, ENVIRONMENT)
    await runWslProcess({
      loginPath: 'none',
      program: '/bin/true',
      env: { PATH: 'C:\\bin', HOME: 'C:\\home', GITLAB_HOST: 'git.example.com' }
    })
    const wslenv = String(runProcessMock.mock.calls.at(-1)?.[0].env.WSLENV ?? '')
    expect(wslenv.split(':')).toContain('GITLAB_HOST')
    expect(wslenv.split(':')).not.toContain('PATH')
    expect(wslenv.split(':')).not.toContain('HOME')
  })
})
