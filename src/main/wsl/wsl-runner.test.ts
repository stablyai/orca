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

beforeEach(() => {
  runProcessMock.mockReset()
  runProcessMock.mockResolvedValue({
    code: 0,
    signal: null,
    stdout: '',
    stderr: '',
    timedOut: false
  })
  invalidateWslGuestEnvironment()
})

afterEach(() => {
  invalidateWslGuestEnvironment()
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

  it('falls back to the interactive lane when the distro cannot be probed', async () => {
    // "We could not ask" must not become "run with no PATH" -- that would turn
    // an unknown into a wrong answer.
    runProcessMock.mockResolvedValue({
      code: 1,
      signal: null,
      stdout: '',
      stderr: 'distro is stopped',
      timedOut: false
    })
    await runWslProcess({ lane: 'probe', program: 'codex' })
    const argv = lastArgv()
    expect(argv).toContain('--exec')
    expect(argv.slice(-2, -1)).toEqual(['-c'])
    expect(argv.at(-1)).toContain('_orca_wsl_shell')
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

describe('a script never rides the interactive lane', () => {
  it('runs sh -s even when the distro cannot be probed', async () => {
    // The login shell owns stdin, and the script arrives on stdin. If the shell
    // consumed it, `sh -s` would read EOF, run nothing and exit 0 -- a silent
    // wrong answer, worse than the degraded PATH this avoids.
    runProcessMock.mockResolvedValue({
      code: 1,
      signal: null,
      stdout: '',
      stderr: 'distro is stopped',
      timedOut: false
    })
    await runWslProcess({ lane: 'probe', script: 'echo hi' })
    expect(lastArgv()).toEqual(['--exec', 'sh', '-s', '--'])
    expect(runProcessMock.mock.calls.at(-1)?.[0].input).toBe('echo hi')
  })
})
