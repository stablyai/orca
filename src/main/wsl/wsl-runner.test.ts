import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

const ENVIRONMENT = {
  path: '/home/u/.nvm/bin:/usr/bin',
  home: '/home/u',
  envBinary: '/usr/bin/env'
}

function lastArgv(): string[] {
  return runProcessMock.mock.calls.at(-1)?.[0].args as string[]
}

/**
 * Default mock: echo the fence back. The interactive lane now treats a missing
 * fence as a failure rather than as empty output, so a bare '' stdout would
 * mean "the login shell never ran our command".
 */
function fencedEcho(payload = ''): void {
  runProcessMock.mockImplementation(async (spec: { args: string[] }) => {
    const script = spec.args.at(-1) ?? ''
    const begin = /__ORCA_WSL_CAPTURE_BEGIN_[a-z0-9]+__/.exec(script)?.[0] ?? ''
    const end = /__ORCA_WSL_CAPTURE_END_[a-z0-9]+__/.exec(script)?.[0] ?? ''
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
      // Why this is pinned on both lanes: under `--`, wsl.exe expands $name in
      // every forwarded argument before the guest runs -- even with no shell in
      // the command -- so a script means something other than what it says
      // (#12964). No escaping on our side is a reliable substitute.
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
})

describe('probe lane', () => {
  it('runs with the cached login PATH and no shell', async () => {
    // The whole point: the user's real PATH without paying for -- or being
    // blocked by -- a login shell on every call (#14288, #9768).
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
    // A missing login PATH used to throw, and every knob this runner carried --
    // cooldown tiers, budget splitting, a re-probe heuristic, an opt-out on 19
    // of 23 sites -- existed to work around that. It is now just a fact in the
    // result.
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
    // A script the runner pipes cannot coexist with a command that reads stdin:
    // the command drains the rest of the script, the shell hits EOF and exits
    // 0, and the truncation is silent. argv has no such conflict, and --exec
    // means no host-side shell re-parses the quotes (#14292).
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
    // The regression this pins: with the script piped, `ssh -T` in a user hook
    // drains the pipe, bash reads EOF, exits 0, and every later line of the
    // hook silently never runs -- while the caller logs success.
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
    // A user hook is the one unbounded script here (`run-both` concatenates two
    // orca.yaml scripts, and a vendored installer is ~15KB). Windows caps the
    // command line at 32767, so argv would fail to spawn at all; stdin still
    // runs it, which is the lesser loss.
    seedWslGuestEnvironmentForTests(undefined, ENVIRONMENT)
    const script = `echo ${'x'.repeat(31_000)}`
    await runWslProcess({ loginPath: 'preferred', shell: 'bash', script })
    const spec = runProcessMock.mock.calls.at(-1)?.[0]
    expect(spec.input).toBe(script)
    expect(lastArgv().slice(-3)).toEqual(['bash', '-s', '--'])
  })

  it('flips to stdin when the login PATH, not the script, is what overflows', async () => {
    // The perverse band a script-only threshold created: with a long enough
    // PATH spliced in as `PATH=...`, a 7,999-char hook went to argv and failed
    // to spawn, while the SAME hook at 8,001 chars flipped to stdin and ran.
    // Size decided how a hook behaved, in the wrong direction.
    seedWslGuestEnvironmentForTests(undefined, {
      ...ENVIRONMENT,
      path: '/opt/x/bin:'.repeat(2_500)
    })
    // Deliberately UNDER any script-only threshold: 7k of script with 27k of
    // PATH overflows the line, and the old rule sent exactly this to argv.
    const script = `echo ${'x'.repeat(7_000)}`
    expect(script.length).toBeLessThan(8_000)
    await runWslProcess({ loginPath: 'preferred', shell: 'bash', script })
    const spec = runProcessMock.mock.calls.at(-1)?.[0]
    expect(spec.input).toBe(script)
    expect(spec.args.join(' ')).not.toContain(script)
  })

  it('charges quoting, so a quote-dense script cannot slip over the real cap', async () => {
    // libuv escapes every `"` and doubles backslash runs, so a script's cost is
    // more than its length. Counting length alone put a quote-heavy ~26KB
    // script on argv and over the 32767 ceiling.
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
    // Unset, a Windows-side variable silently never reaches the guest (#12557).
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
    // Without it wsl.exe writes its own error text as UTF-16LE, so anything
    // surfacing stderr shows NUL-riddled output (#9010).
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
    // The contract is that the GUEST path never becomes wsl.exe's Windows cwd,
    // not that there is no cwd: inheriting one is its own bug (#16463).
    expect(runProcessMock.mock.calls.at(-1)?.[0].cwd).not.toBe('/home/u/repo')
    expect(runProcessMock.mock.calls.at(-1)?.[0].cwd).toEqual(expect.any(String))
    expect(lastArgv()).toContain('/home/u/repo')
    expect(lastArgv()).toContain('sh')
  })

  it.each([['C:\\repo'], ['relative/path']])('rejects %s as a guest cwd', async (cwd) => {
    // A Windows path here means a mistake further up; converting it silently
    // hides that.
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
    // --exec passes the program as one argv element, so a space is harmless;
    // rejecting it would fail legitimate installs under a spaced directory.
    seedWslGuestEnvironmentForTests(undefined, ENVIRONMENT)
    await expect(
      runWslProcess({ loginPath: 'preferred', program: '/home/u/my tools/codex' })
    ).resolves.toBeDefined()
  })
})

describe('program is not an assignment', () => {
  it('rejects a name=value program that env would swallow', async () => {
    // `env PATH=… HOME=… FOO=bar` has no command left: it prints the whole
    // guest environment and exits 0 -- success, with the environment as stdout.
    seedWslGuestEnvironmentForTests(undefined, ENVIRONMENT)
    await expect(runWslProcess({ loginPath: 'preferred', program: 'FOO=bar' })).rejects.toThrow(
      /assignment/
    )
  })
})

describe('timeout budget', () => {
  it('leaves the command time after a slow probe', async () => {
    // The probe used to run on its own 10s timer ahead of the timed leg, so a
    // 5s caller could reach runProcess with 1ms left and report a timeout for a
    // command that would have taken milliseconds.
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
    // The probe used to take two thirds, so a 5s caller reached runProcess with
    // ~1667ms -- less than the 5s it had before the runner existed, which is
    // how a cold distro came back as "not installed".
    // No seed: the probe must actually run, or this measures the command leg
    // and passes for any split. A failed probe is non-fatal now, so the call
    // still reaches its command.
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
    // A payload using process substitution (`done < <(find ...)`), `local` or
    // `[[ ]]` is bash-only. Running it under dash yields `Syntax error: word
    // unexpected` -- the #14292 signature -- so a bash caller must be able to
    // say so rather than be silently downgraded.
    seedWslGuestEnvironmentForTests(undefined, ENVIRONMENT)
    await runWslProcess({ loginPath: 'preferred', script: 'done < <(find .)', shell: 'bash' })
    expect(lastArgv()).toContain('bash')
    expect(lastArgv()).not.toContain('sh')
  })
})

describe('a script never rides a login shell', () => {
  it('runs the script shell-free even when the distro cannot be probed', async () => {
    // No login shell in the way: it would own stdin and could consume it,
    // leaving the script's shell to read EOF, run nothing and exit 0 -- a
    // silent wrong answer, worse than the degraded PATH this avoids.
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
    // wsl.exe translates path-shaped variables between Windows and Linux form,
    // so naming PATH in WSLENV replaces the guest's own PATH with a translated
    // Windows one. Silent, and fatal to every lookup that follows.
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
