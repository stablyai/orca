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
  it.each([
    ['probe', 'probe'],
    ['interactive', 'interactive']
  ] as const)('uses --exec and never -- on the %s lane', async (_name, lane) => {
    // Why this is pinned on both lanes: under `--`, wsl.exe expands $name in
    // every forwarded argument before the guest runs -- even with no shell in
    // the command -- so a script means something other than what it says
    // (#12964). No escaping on our side is a reliable substitute.
    seedWslGuestEnvironmentForTests(undefined, ENVIRONMENT)
    await runWslProcess({ lane, program: '/usr/bin/git', args: ['status'] })
    expect(lastArgv()).toContain('--exec')
    expect(lastArgv()).not.toContain('--')
  })

  it('passes the distro before --exec', async () => {
    seedWslGuestEnvironmentForTests('Ubuntu', ENVIRONMENT)
    await runWslProcess({ lane: 'probe', distro: 'Ubuntu', program: '/bin/true' })
    expect(lastArgv().slice(0, 3)).toEqual(['-d', 'Ubuntu', '--exec'])
  })
})

describe('probe lane', () => {
  it('runs with the cached login PATH and no shell', async () => {
    // The whole point: the user's real PATH without paying for -- or being
    // blocked by -- a login shell on every call (#14288, #9768).
    seedWslGuestEnvironmentForTests(undefined, ENVIRONMENT)
    await runWslProcess({ lane: 'probe', program: 'codex', args: ['--version'] })
    expect(lastArgv()).toEqual([
      '--exec',
      '/usr/bin/env',
      'PATH=/home/u/.nvm/bin:/usr/bin',
      'HOME=/home/u',
      'codex',
      '--version'
    ])
  })

  it('reports an unresolved environment rather than pretending the PATH is real', async () => {
    // Falling back to the login shell here would re-run ~/.profile -- the very
    // stall the probe lane exists to avoid, and most likely to bite exactly
    // when the probe just failed. So the call proceeds on the default PATH and
    // says so, and callers deciding "installed?" must treat that as unknown.
    let call = 0
    runProcessMock.mockImplementation(async (spec: { args: string[] }) => {
      call += 1
      if (call === 1) {
        return { environmentResolved: true, code: 1, signal: null, stdout: '', stderr: 'stopped', timedOut: false }
      }
      const script = spec.args.at(-1) ?? ''
      const begin = /__ORCA_WSL_CAPTURE_BEGIN_[a-z0-9]+__/.exec(script)?.[0] ?? ''
      const end = /__ORCA_WSL_CAPTURE_END_[a-z0-9]+__/.exec(script)?.[0] ?? ''
      return { environmentResolved: true, code: 0, signal: null, stdout: `${begin}${end}`, stderr: '', timedOut: false }
    })
    // Default is to refuse: answering "is codex installed?" on the bare default
    // PATH reports an nvm install as absent, which is #9725.
    await expect(runWslProcess({ lane: 'probe', program: 'codex' })).rejects.toThrow(
      /guest environment/
    )

    const degraded = await runWslProcess({
      lane: 'probe',
      program: 'codex',
      allowDegradedEnvironment: true
    })
    expect(degraded.environmentResolved).toBe(false)
    expect(lastArgv()).toEqual(['--exec', 'codex'])
  })

  it('reports a resolved environment on the happy path', async () => {
    seedWslGuestEnvironmentForTests(undefined, ENVIRONMENT)
    const result = await runWslProcess({ lane: 'probe', program: 'codex' })
    expect(result.environmentResolved).toBe(true)
  })
})

describe('interactive lane', () => {
  it('always fences stdout, even when the caller ignores it', async () => {
    // Stock Ubuntu writes its rc hint to stdout, so an unfenced parse reads the
    // banner as data (#11327, #11823). A caller that starts parsing later must
    // not have to remember to opt in.
    runProcessMock.mockImplementation(async (spec: { args: string[] }) => {
      const script = spec.args.at(-1) ?? ''
      const begin = /__ORCA_WSL_CAPTURE_BEGIN_[a-z0-9]+__/.exec(script)?.[0] ?? ''
      const end = /__ORCA_WSL_CAPTURE_END_[a-z0-9]+__/.exec(script)?.[0] ?? ''
      return {
        environmentResolved: true,
        code: 0,
        signal: null,
        stdout: `Ubuntu banner: run a command as administrator\n${begin}payload${end}`,
        stderr: '',
        timedOut: false
      }
    })
    const result = await runWslProcess({ lane: 'interactive', program: 'claude' })
    expect(result.stdout).toBe('payload')
  })
})

describe('scripts', () => {
  it('delivers a script on stdin through sh -s, not in argv', async () => {
    // A script on stdin has no quoting boundary for its own quotes to escape
    // from. That is what the base64 and eval wrappers were working around
    // (#14292), and why this is the only supported way to run one.
    seedWslGuestEnvironmentForTests(undefined, ENVIRONMENT)
    const script = `case "$x" in a) echo 'it'\\''s fine';; esac`
    await runWslProcess({ lane: 'probe', script, args: ['/tmp/root'] })
    expect(runProcessMock.mock.calls.at(-1)?.[0].input).toBe(script)
    expect(lastArgv()).toEqual([
      '--exec',
      '/usr/bin/env',
      'PATH=/home/u/.nvm/bin:/usr/bin',
      'HOME=/home/u',
      'sh',
      '-s',
      '--',
      '/tmp/root'
    ])
    expect(lastArgv().join(' ')).not.toContain('case')
  })
})

describe('WSLENV', () => {
  it('adds every propagated key so the value actually crosses the boundary', async () => {
    // Unset, a Windows-side variable silently never reaches the guest (#12557).
    seedWslGuestEnvironmentForTests(undefined, ENVIRONMENT)
    await runWslProcess({
      lane: 'probe',
      program: '/bin/true',
      env: { GITLAB_HOST: 'git.example.com', GH_TOKEN: 't' }
    })
    const env = runProcessMock.mock.calls.at(-1)?.[0].env as NodeJS.ProcessEnv
    expect(env.GITLAB_HOST).toBe('git.example.com')
    expect(env.WSLENV?.split(':')).toEqual(expect.arrayContaining(['GITLAB_HOST', 'GH_TOKEN']))
  })

  it('leaves the host environment alone when nothing is propagated', async () => {
    seedWslGuestEnvironmentForTests(undefined, ENVIRONMENT)
    await runWslProcess({ lane: 'probe', program: '/bin/true' })
    expect(runProcessMock.mock.calls.at(-1)?.[0].env).toBeUndefined()
  })
})

describe('guest cwd', () => {
  it('cds inside the guest rather than passing a Windows cwd to wsl.exe', async () => {
    seedWslGuestEnvironmentForTests(undefined, ENVIRONMENT)
    await runWslProcess({ lane: 'probe', program: '/usr/bin/git', cwd: '/home/u/repo' })
    expect(runProcessMock.mock.calls.at(-1)?.[0].cwd).toBeUndefined()
    expect(lastArgv()).toContain('/home/u/repo')
    expect(lastArgv()).toContain('sh')
  })

  it.each([['C:\\repo'], ['relative/path']])('rejects %s as a guest cwd', async (cwd) => {
    // A Windows path here means a mistake further up; converting it silently
    // hides that.
    seedWslGuestEnvironmentForTests(undefined, ENVIRONMENT)
    await expect(runWslProcess({ lane: 'probe', program: '/bin/true', cwd })).rejects.toThrow(
      /guest path/
    )
  })
})

describe('program is a binary, not a shell string', () => {
  it.each([['sh -c echo hi'], ['a; b'], ['a | b'], ['a && b'], ['echo $HOME'], ['a > b']])(
    'rejects %s',
    async (program) => {
      await expect(runWslProcess({ lane: 'probe', program })).rejects.toThrow(/single binary/)
    }
  )

  it('allows a guest path containing a space', async () => {
    // --exec passes the program as one argv element, so a space is harmless;
    // rejecting it would fail legitimate installs under a spaced directory.
    seedWslGuestEnvironmentForTests(undefined, ENVIRONMENT)
    await expect(
      runWslProcess({ lane: 'probe', program: '/home/u/my tools/codex' })
    ).resolves.toBeDefined()
  })
})

describe('a script gets the cached environment on both lanes', () => {
  it('applies the cached PATH even when the caller asked for interactive', async () => {
    // A script never runs under the login shell (it owns stdin), so without
    // this the interactive lane would give a script LESS PATH than the probe
    // lane -- for a caller that explicitly asked for the user's terminal PATH.
    seedWslGuestEnvironmentForTests(undefined, ENVIRONMENT)
    await runWslProcess({ lane: 'interactive', script: 'command -v codex' })
    expect(lastArgv()).toEqual([
      '--exec',
      '/usr/bin/env',
      'PATH=/home/u/.nvm/bin:/usr/bin',
      'HOME=/home/u',
      'sh',
      '-s',
      '--'
    ])
  })
})

describe('a missing fence is a failure, not empty output', () => {
  it('throws rather than returning a clean empty result', async () => {
    // readStdout returns null precisely to distinguish "no fence" from "empty
    // payload". An rc that redirects stdout would otherwise yield a silent
    // wrong answer.
    runProcessMock.mockResolvedValue({
      environmentResolved: true,
      code: 0,
      signal: null,
      stdout: 'banner only, no fence',
      stderr: '',
      timedOut: false
    })
    await expect(runWslProcess({ lane: 'interactive', program: 'claude' })).rejects.toThrow(
      /no fenced output/
    )
  })
})

describe('program is not an assignment', () => {
  it('rejects a name=value program that env would swallow', async () => {
    // `env PATH=… HOME=… FOO=bar` has no command left: it prints the whole
    // guest environment and exits 0 -- success, with the environment as stdout.
    seedWslGuestEnvironmentForTests(undefined, ENVIRONMENT)
    await expect(runWslProcess({ lane: 'probe', program: 'FOO=bar' })).rejects.toThrow(
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
    await runWslProcess({ lane: 'probe', program: '/bin/true', timeoutMs: 5_000 })
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
    // and passes for any split. allowDegradedEnvironment keeps the call alive
    // once the probe fails.
    await runWslProcess({
      lane: 'probe',
      program: '/bin/true',
      timeoutMs,
      allowDegradedEnvironment: true
    })
    const probeMs = runProcessMock.mock.calls[0]?.[0].timeoutMs as number
    expect(probeMs).toBeLessThanOrEqual(timeoutMs - floor)
  })
})

describe('script interpreter', () => {
  it('defaults to sh', async () => {
    seedWslGuestEnvironmentForTests(undefined, ENVIRONMENT)
    await runWslProcess({ lane: 'probe', script: 'echo hi' })
    expect(lastArgv()).toContain('sh')
    expect(lastArgv()).not.toContain('bash')
  })

  it('honours an explicit bash request', async () => {
    // A payload using process substitution (`done < <(find ...)`), `local` or
    // `[[ ]]` is bash-only. Running it under dash yields `Syntax error: word
    // unexpected` -- the #14292 signature -- so a bash caller must be able to
    // say so rather than be silently downgraded.
    seedWslGuestEnvironmentForTests(undefined, ENVIRONMENT)
    await runWslProcess({ lane: 'probe', script: 'done < <(find .)', shell: 'bash' })
    expect(lastArgv()).toContain('bash')
    expect(lastArgv()).not.toContain('sh')
  })
})

describe('a script never rides the interactive lane', () => {
  it('runs sh -s even when the distro cannot be probed', async () => {
    // The login shell owns stdin, and the script arrives on stdin. If the shell
    // consumed it, `sh -s` would read EOF, run nothing and exit 0 -- a silent
    // wrong answer, worse than the degraded PATH this avoids.
    runProcessMock.mockResolvedValue({
      environmentResolved: true,
      code: 1,
      signal: null,
      stdout: '',
      stderr: 'distro is stopped',
      timedOut: false
    })
    await runWslProcess({ lane: 'probe', script: 'echo hi', allowDegradedEnvironment: true })
    expect(lastArgv()).toEqual(['--exec', 'sh', '-s', '--'])
    expect(runProcessMock.mock.calls.at(-1)?.[0].input).toBe('echo hi')
  })
})
