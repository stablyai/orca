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
        ORCA_WORKSPACE_ID: 'ws-1',
        // Why: these are remote-machine paths and must not leak into the host
        // subprocess (PATH would break host binary lookup; user-data would
        // retarget the CLI at a different local instance).
        PATH: '/remote/bin',
        ORCA_USER_DATA_PATH: '/remote/user-data'
      },
      userDataPath: '/host/user-data',
      remoteCwd: '/home/alice/wt/sub'
    })

    expect(env.ORCA_TERMINAL_HANDLE).toBe('term_remote')
    expect(env.ORCA_WORKTREE_ID).toBe('repo::/home/alice/wt')
    expect(env.ORCA_PANE_KEY).toBe('pane-9')
    expect(env.ORCA_WORKSPACE_ID).toBe('ws-1')
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
