import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => '/host/app'
  }
}))
vi.mock('../persistence', () => ({
  getCanonicalUserDataPath: () => '/host/user-data'
}))

import {
  HostCliUnavailableError,
  buildHostCliEnv,
  resolveHostCliEntryPath,
  resolveHostCliKillTimeoutMs,
  runHostOrcaCliPassthrough
} from './ssh-remote-cli-host-passthrough'
import { resolveOrchestrationAskClientTimeoutMs } from '../../shared/orchestration-ask-timeout'
import { remoteCliRequestTimeoutMs } from '../../relay/remote-cli-timeout'
import { MAX_TIMER_DELAY_MS } from '../../shared/timer-delay'
import {
  ORCHESTRATION_COMPATIBILITY_ATTACHMENT_ENV,
  ORCHESTRATION_COMPATIBILITY_HOST_ID_ENV,
  ORCHESTRATION_COMPATIBILITY_HOST_INCARNATION_ENV,
  ORCHESTRATION_COMPATIBILITY_HOST_KIND_ENV
} from '../../shared/orchestration-compatibility-evidence'

type FakeChild = EventEmitter & {
  stdout: EventEmitter
  stderr: EventEmitter
  stdin: { end: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn> }
  kill: ReturnType<typeof vi.fn>
}

function createFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.stdin = { end: vi.fn(), on: vi.fn() }
  child.kill = vi.fn()
  return child
}

const BASE_OPTIONS = {
  execPath: '/host/electron',
  cliEntryPath: '/host/app/out/cli/index.js',
  userDataPath: '/host/user-data',
  entryExists: () => true
}

describe('resolveHostCliEntryPath', () => {
  it('uses the in-repo entry for dev builds and the unpacked asar entry when packaged', () => {
    expect(
      resolveHostCliEntryPath({ isPackaged: false, resourcesPath: '/r', appPath: '/host/app' })
    ).toBe(join('/host/app', 'out', 'cli', 'index.js'))
    expect(
      resolveHostCliEntryPath({ isPackaged: true, resourcesPath: '/r', appPath: '/host/app' })
    ).toBe(join('/r', 'app.asar.unpacked', 'out', 'cli', 'index.js'))
  })
})

describe('buildHostCliEnv', () => {
  it('forwards only Orca terminal-context vars from the remote env', () => {
    const env = buildHostCliEnv({
      hostEnv: { PATH: '/host/bin', NODE_OPTIONS: '--inspect' },
      remoteEnv: {
        ORCA_TERMINAL_HANDLE: 'term_remote',
        ORCA_WORKTREE_ID: 'repo::/home/alice/wt',
        ORCA_PANE_KEY: 'pane-9',
        ORCA_AGENT_LAUNCH_TOKEN: 'launch-secret',
        ORCA_WORKSPACE_ID: 'ws-1',
        [ORCHESTRATION_COMPATIBILITY_HOST_KIND_ENV]: 'wsl',
        [ORCHESTRATION_COMPATIBILITY_HOST_ID_ENV]: 'caller-host',
        [ORCHESTRATION_COMPATIBILITY_HOST_INCARNATION_ENV]: 'caller-incarnation',
        [ORCHESTRATION_COMPATIBILITY_ATTACHMENT_ENV]: 'caller-attachment',
        // Why: these are remote-machine paths and must not leak into the host
        // subprocess (PATH would break host binary lookup; user-data would
        // retarget the CLI at a different local instance).
        PATH: '/remote/bin',
        ORCA_USER_DATA_PATH: '/remote/user-data'
      },
      userDataPath: '/host/user-data',
      remoteCwd: '/home/alice/wt/sub',
      runtimeAuthority: {
        kind: 'ssh',
        targetId: 'saved-target',
        connectionIncarnation: 'connection-incarnation',
        attachmentId: 'runtime-attachment'
      }
    })

    expect(env.ORCA_TERMINAL_HANDLE).toBe('term_remote')
    expect(env.ORCA_WORKTREE_ID).toBe('repo::/home/alice/wt')
    expect(env.ORCA_PANE_KEY).toBe('pane-9')
    expect(env.ORCA_AGENT_LAUNCH_TOKEN).toBe('launch-secret')
    expect(env.ORCA_WORKSPACE_ID).toBe('ws-1')
    expect(env[ORCHESTRATION_COMPATIBILITY_HOST_KIND_ENV]).toBe('ssh')
    expect(env[ORCHESTRATION_COMPATIBILITY_HOST_ID_ENV]).toBe('saved-target')
    expect(env[ORCHESTRATION_COMPATIBILITY_HOST_INCARNATION_ENV]).toBe('connection-incarnation')
    expect(env[ORCHESTRATION_COMPATIBILITY_ATTACHMENT_ENV]).toBe('runtime-attachment')
    expect(env.PATH).toBe('/host/bin')
    expect(env.ORCA_USER_DATA_PATH).toBe('/host/user-data')
    expect(env.ORCA_CLI_CWD).toBe('/home/alice/wt/sub')
    expect(env.ELECTRON_RUN_AS_NODE).toBe('1')
    expect(env.NODE_OPTIONS).toBeUndefined()
    expect(env.ORCA_NODE_OPTIONS).toBe('--inspect')
  })
})

describe('resolveHostCliKillTimeoutMs', () => {
  it('extends the kill timer past an explicit --timeout-ms budget', () => {
    expect(resolveHostCliKillTimeoutMs(['terminal', 'wait', '--timeout-ms', '1800000'])).toBe(
      1_920_000
    )
    expect(resolveHostCliKillTimeoutMs(['orchestration', 'check', '--timeout-ms=5000'])).toBe(
      600_000
    )
    expect(resolveHostCliKillTimeoutMs(['worktree', 'list'])).toBe(600_000)
  })

  it.each([
    [[], 720_000],
    [['--timeout-ms', String(Number.MAX_SAFE_INTEGER)], 1_920_000],
    [['--timeout-ms', String(Number.MAX_SAFE_INTEGER + 1)], 720_000],
    [['--timeout-ms', '9007199254740991.1'], 720_000],
    [['--timeout-ms', '1', '--timeout-ms=1800000'], 1_920_000],
    [['--timeout-ms=1800000', '--timeout-ms', '1'], 600_000],
    [['--timeout-ms', '1800000', '--timeout-ms'], 720_000],
    [['--timeout-ms=1800000', '--timeout-ms='], 720_000],
    [['--timeout-ms=1800000', '--timeout-ms', 'bad'], 720_000],
    [['--timeout-ms', 'bad', '--timeout-ms=1800000'], 1_920_000],
    [['--timeout-ms=bad', '--timeout-ms', '1800000'], 1_920_000]
  ])('bounds ask child timers with last-wins flags %#', (timeoutArgs, expected) => {
    expect(resolveHostCliKillTimeoutMs(['orchestration', '--json', 'ask', ...timeoutArgs])).toBe(
      expected
    )
  })

  it('does not apply the ask maximum to other commands', () => {
    expect(resolveHostCliKillTimeoutMs(['terminal', 'wait', '--timeout-ms', '1800001'])).toBe(
      1_920_001
    )
  })

  it.each(['+1000000', '1000000.0', '1e6'])(
    'extends non-ask child timers using CLI-compatible integer syntax %s',
    (raw) => {
      expect(resolveHostCliKillTimeoutMs(['terminal', 'wait', '--timeout-ms', raw])).toBe(1_120_000)
    }
  )

  it.each([
    'Infinity',
    '1.5',
    '-1',
    'bad',
    String(Number.MAX_SAFE_INTEGER),
    String(MAX_TIMER_DELAY_MS - 120_000 + 1)
  ])('falls back to the default kill timer when a non-ask --timeout-ms %s is unusable', (raw) => {
    expect(resolveHostCliKillTimeoutMs(['terminal', 'wait', '--timeout-ms', raw])).toBe(600_000)
  })

  it('keeps the largest non-ask kill timer that stays inside the timer range', () => {
    expect(
      resolveHostCliKillTimeoutMs([
        'terminal',
        'wait',
        '--timeout-ms',
        String(MAX_TIMER_DELAY_MS - 120_000)
      ])
    ).toBe(MAX_TIMER_DELAY_MS)
  })

  it.each<[string[], number | undefined]>([
    [[], undefined],
    [['--timeout-ms', '1'], 1],
    [['--timeout-ms', String(Number.MAX_SAFE_INTEGER)], Number.MAX_SAFE_INTEGER],
    [['--timeout-ms', String(Number.MAX_SAFE_INTEGER + 1)], undefined]
  ])('keeps inner, host, and relay ask deadlines ordered %#', (timeoutArgs, parsedTimeout) => {
    const argv = ['orchestration', 'ask', '--to', 'term_x', ...timeoutArgs]
    const innerTimeout = resolveOrchestrationAskClientTimeoutMs(parsedTimeout)
    const hostTimeout = resolveHostCliKillTimeoutMs(argv)
    const relayTimeout = remoteCliRequestTimeoutMs({ argv })

    expect(innerTimeout).toBeLessThan(hostTimeout)
    expect(hostTimeout).toBeLessThan(relayTimeout!)
  })
})

describe('runHostOrcaCliPassthrough', () => {
  it('spawns the bundled CLI entry with the remote argv and returns captured output', async () => {
    const child = createFakeChild()
    const spawn = vi.fn(() => child)

    const resultPromise = runHostOrcaCliPassthrough(
      {
        argv: ['orchestration', 'task-create', '--spec', 'do the thing', '--json'],
        cwd: '/home/alice/wt',
        env: { ORCA_TERMINAL_HANDLE: 'term_remote' }
      },
      { ...BASE_OPTIONS, spawn: spawn as never }
    )

    await Promise.resolve()
    child.stdout.emit('data', Buffer.from('{"ok":true}\n'))
    child.stderr.emit('data', Buffer.from('warn\n'))
    child.emit('close', 0)

    const result = await resultPromise
    expect(result).toEqual({ stdout: '{"ok":true}\n', stderr: 'warn\n', exitCode: 0 })

    expect(spawn).toHaveBeenCalledTimes(1)
    const [execPath, args, options] = spawn.mock.calls[0] as unknown as [
      string,
      string[],
      { env: NodeJS.ProcessEnv }
    ]
    expect(execPath).toBe('/host/electron')
    expect(args).toEqual([
      '/host/app/out/cli/index.js',
      'orchestration',
      'task-create',
      '--spec',
      'do the thing',
      '--json'
    ])
    expect(options.env.ELECTRON_RUN_AS_NODE).toBe('1')
    expect(options.env.ORCA_CLI_CWD).toBe('/home/alice/wt')
    expect(options.env.ORCA_TERMINAL_HANDLE).toBe('term_remote')
    // Why: stdin must be closed even without a payload so CLI handlers that
    // stream stdin see EOF instead of hanging forever.
    expect(child.stdin.end).toHaveBeenCalledWith()
  })

  it('pipes a stdin payload to the CLI subprocess', async () => {
    const child = createFakeChild()
    const spawn = vi.fn(() => child)

    const resultPromise = runHostOrcaCliPassthrough(
      {
        argv: ['linear', 'comment', 'add', 'ENG-1', '--body-file', '-'],
        cwd: '/home/alice/wt',
        env: {},
        stdin: 'comment body'
      },
      { ...BASE_OPTIONS, spawn: spawn as never }
    )

    await Promise.resolve()
    child.emit('close', 0)
    await resultPromise

    expect(child.stdin.end).toHaveBeenCalledWith('comment body')
  })

  it('propagates non-zero exit codes', async () => {
    const child = createFakeChild()
    const spawn = vi.fn(() => child)

    const resultPromise = runHostOrcaCliPassthrough(
      { argv: ['worktree', 'show'], cwd: '/', env: {} },
      { ...BASE_OPTIONS, spawn: spawn as never }
    )

    await Promise.resolve()
    child.stderr.emit('data', Buffer.from('boom\n'))
    child.emit('close', 3)

    await expect(resultPromise).resolves.toEqual({ stdout: '', stderr: 'boom\n', exitCode: 3 })
  })

  it('throws HostCliUnavailableError when the CLI entry is missing', async () => {
    const spawn = vi.fn()
    await expect(
      runHostOrcaCliPassthrough(
        { argv: ['status'], cwd: '/', env: {} },
        { ...BASE_OPTIONS, entryExists: () => false, spawn: spawn as never }
      )
    ).rejects.toBeInstanceOf(HostCliUnavailableError)
    expect(spawn).not.toHaveBeenCalled()
  })

  it('rejects an invalid injected kill timeout before spawning', async () => {
    const spawn = vi.fn()
    await expect(
      runHostOrcaCliPassthrough(
        { argv: ['status'], cwd: '/', env: {} },
        { ...BASE_OPTIONS, spawn: spawn as never, killTimeoutMs: 2_147_483_648 }
      )
    ).rejects.toBeInstanceOf(RangeError)
    expect(spawn).not.toHaveBeenCalled()
  })

  it('throws HostCliUnavailableError when the subprocess fails to launch', async () => {
    const child = createFakeChild()
    const spawn = vi.fn(() => child)

    const resultPromise = runHostOrcaCliPassthrough(
      { argv: ['status'], cwd: '/', env: {} },
      { ...BASE_OPTIONS, spawn: spawn as never }
    )

    await Promise.resolve()
    child.emit('error', new Error('spawn ENOENT'))

    await expect(resultPromise).rejects.toBeInstanceOf(HostCliUnavailableError)
  })

  it('kills the subprocess and reports an error when the kill timeout elapses', async () => {
    vi.useFakeTimers()
    try {
      const child = createFakeChild()
      const spawn = vi.fn(() => child)

      const resultPromise = runHostOrcaCliPassthrough(
        { argv: ['terminal', 'wait', '--for', 'exit'], cwd: '/', env: {} },
        { ...BASE_OPTIONS, spawn: spawn as never, killTimeoutMs: 1000 }
      )

      await vi.advanceTimersByTimeAsync(1001)
      const result = await resultPromise
      expect(child.kill).toHaveBeenCalledWith('SIGKILL')
      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain('timed out')
    } finally {
      vi.useRealTimers()
    }
  })

  it('caps runaway output instead of buffering it unbounded', async () => {
    const child = createFakeChild()
    const spawn = vi.fn(() => child)

    const resultPromise = runHostOrcaCliPassthrough(
      { argv: ['terminal', 'read'], cwd: '/', env: {} },
      { ...BASE_OPTIONS, spawn: spawn as never }
    )

    await Promise.resolve()
    const chunk = Buffer.alloc(3 * 1024 * 1024, 97)
    for (let i = 0; i < 4; i += 1) {
      child.stdout.emit('data', chunk)
    }
    child.emit('close', 0)

    const result = await resultPromise
    expect(result.stdout.length).toBeLessThanOrEqual(8 * 1024 * 1024 + 64)
    expect(result.stdout).toContain('output truncated')
  })
})
