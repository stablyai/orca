import { execFile, spawn } from 'node:child_process'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ChildProcess from 'node:child_process'
import { createFakeChild, createHandlers, requestContext } from './agent-exec-handler-test-harness'
import { TERMINAL_GIT_CREDENTIAL_GUARD_POLICY_ENV } from '../shared/terminal-git-credential-guard'

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>()
  return {
    ...actual,
    execFile: vi.fn(),
    spawn: vi.fn()
  }
})

const spawnMock = vi.mocked(spawn)
const execFileMock = vi.mocked(execFile)

type AgentExecResult = { exitCode: number | null; timedOut: boolean }

describe('AgentExecHandler', () => {
  beforeEach(() => {
    spawnMock.mockReset()
    execFileMock.mockReset()
  })

  it('executes a non-interactive command with captured output and stdin', async () => {
    const child = createFakeChild()
    spawnMock.mockReturnValue(child as never)
    const handlers = createHandlers()

    const pending = handlers.get('agent.execNonInteractive')!(
      {
        binary: 'agent',
        args: ['--flag', 42],
        cwd: '/repo',
        stdin: 'PROMPT',
        timeoutMs: 5_000
      },
      requestContext()
    )

    child.stdout.emit('data', Buffer.from('message'))
    child.stderr.emit('data', Buffer.from('warning'))
    child.emit('close', 0)

    await expect(pending).resolves.toEqual({
      stdout: 'message',
      stderr: 'warning',
      exitCode: 0,
      timedOut: false,
      canceled: false
    })
    expect(spawnMock).toHaveBeenCalledWith('agent', ['--flag', '42'], {
      cwd: '/repo',
      env: expect.objectContaining({
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GCM_INTERACTIVE: 'never'
      }),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })
    expect(child.stdin.end).toHaveBeenCalledWith('PROMPT')
  })

  it('merges caller-supplied provider environment into the spawned command environment', async () => {
    const child = createFakeChild()
    spawnMock.mockReturnValue(child as never)
    const handlers = createHandlers()

    const pending = handlers.get('agent.execNonInteractive')!(
      {
        binary: 'codex',
        args: ['exec'],
        cwd: '/repo',
        stdin: 'PROMPT',
        timeoutMs: 5_000,
        env: {
          CODEX_HOME: '/managed/codex-home',
          PATH: '/managed/bin'
        }
      },
      requestContext()
    )

    child.emit('close', 0)

    await expect(pending).resolves.toMatchObject({
      exitCode: 0,
      timedOut: false
    })
    expect(spawnMock).toHaveBeenCalledWith('codex', ['exec'], {
      cwd: '/repo',
      env: expect.objectContaining({
        ...process.env,
        CODEX_HOME: '/managed/codex-home',
        PATH: '/managed/bin'
      }),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })
  })

  it('consumes an unattended marker and applies the full Git guard on the relay host', async () => {
    const child = createFakeChild()
    spawnMock.mockReturnValue(child as never)
    const handlers = createHandlers()

    const pending = handlers.get('agent.execNonInteractive')!(
      {
        binary: '/bin/bash',
        args: ['-lc', 'git fetch'],
        cwd: '/repo',
        timeoutMs: 5_000,
        env: { [TERMINAL_GIT_CREDENTIAL_GUARD_POLICY_ENV]: 'guard' }
      },
      requestContext()
    )

    child.emit('close', 0)
    await expect(pending).resolves.toMatchObject({ exitCode: 0 })

    const env = spawnMock.mock.calls[0]?.[2]?.env as Record<string, string>
    expect(env[TERMINAL_GIT_CREDENTIAL_GUARD_POLICY_ENV]).toBeUndefined()
    expect(env.GIT_TERMINAL_PROMPT).toBe('0')
    expect(env.GCM_INTERACTIVE).toBe('never')
    expect(Object.values(env)).toContain('credential.interactive')
    expect(Object.values(env)).toContain('credential.guiPrompt')
  })

  it('guards wrapped agents after atomically replacing inherited indexed config', async () => {
    const keys = [
      'GIT_CONFIG_COUNT',
      'GIT_CONFIG_KEY_0',
      'GIT_CONFIG_VALUE_0',
      'GIT_CONFIG_KEY_1',
      'GIT_CONFIG_VALUE_1'
    ] as const
    const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
    process.env.GIT_CONFIG_COUNT = '2'
    process.env.GIT_CONFIG_KEY_0 = 'base.one'
    process.env.GIT_CONFIG_VALUE_0 = 'one'
    process.env.GIT_CONFIG_KEY_1 = 'base.two'
    process.env.GIT_CONFIG_VALUE_1 = 'two'

    try {
      const child = createFakeChild()
      spawnMock.mockReturnValue(child as never)
      const handlers = createHandlers()
      const pending = handlers.get('agent.execNonInteractive')!(
        {
          binary: 'npx',
          args: ['codex', 'exec'],
          cwd: '/repo',
          timeoutMs: 5_000,
          env: {
            GIT_CONFIG_COUNT: '1',
            GIT_CONFIG_KEY_0: 'http.proxy',
            GIT_CONFIG_VALUE_0: 'http://proxy.invalid'
          }
        },
        requestContext()
      )

      child.emit('close', 0)
      await expect(pending).resolves.toMatchObject({ exitCode: 0 })
      const env = spawnMock.mock.calls[0]?.[2]?.env as Record<string, string>
      expect(env.GIT_TERMINAL_PROMPT).toBe('0')
      expect(env.GIT_CONFIG_COUNT).toBe('3')
      expect(env.GIT_CONFIG_KEY_0).toBe('http.proxy')
      expect(env.GIT_CONFIG_KEY_1).toBe('credential.interactive')
      expect(env.GIT_CONFIG_KEY_2).toBe('credential.guiPrompt')
      expect(Object.values(env)).not.toContain('base.two')
    } finally {
      for (const key of keys) {
        if (saved[key] === undefined) {
          delete process.env[key]
        } else {
          process.env[key] = saved[key]
        }
      }
    }
  })

  it('cancels the in-flight command for the requested cwd', async () => {
    const child = createFakeChild()
    spawnMock.mockReturnValue(child as never)
    const handlers = createHandlers()

    const pending = handlers.get('agent.execNonInteractive')!(
      {
        binary: 'agent',
        args: [],
        cwd: '/repo',
        stdin: null,
        timeoutMs: 5_000
      },
      requestContext()
    )

    await expect(
      handlers.get('agent.cancelExec')!({ cwd: '/repo' }, requestContext())
    ).resolves.toEqual({ canceled: true })

    if (process.platform === 'win32') {
      expect(execFileMock).toHaveBeenCalledWith(
        'taskkill',
        ['/pid', '12345', '/T', '/F'],
        expect.any(Function)
      )
    } else {
      expect(child.kill).toHaveBeenCalledWith('SIGKILL')
    }

    child.emit('close', null)
    await expect(pending).resolves.toMatchObject({
      exitCode: null,
      timedOut: false,
      canceled: true
    })
  })

  it('cancels only the matching operation lane for a cwd', async () => {
    const commitChild = createFakeChild()
    const pullRequestChild = createFakeChild()
    pullRequestChild.pid = 12346
    spawnMock
      .mockReturnValueOnce(commitChild as never)
      .mockReturnValueOnce(pullRequestChild as never)
    const handlers = createHandlers()

    const commit = handlers.get('agent.execNonInteractive')!(
      {
        binary: 'agent',
        args: [],
        cwd: '/repo',
        stdin: null,
        timeoutMs: 5_000,
        operation: 'commit-message'
      },
      requestContext()
    )
    const pullRequest = handlers.get('agent.execNonInteractive')!(
      {
        binary: 'agent',
        args: [],
        cwd: '/repo',
        stdin: null,
        timeoutMs: 5_000,
        operation: 'pull-request-fields'
      },
      requestContext()
    )

    await expect(
      handlers.get('agent.cancelExec')!(
        { cwd: '/repo', operation: 'commit-message' },
        requestContext()
      )
    ).resolves.toEqual({ canceled: true })

    if (process.platform === 'win32') {
      expect(execFileMock).toHaveBeenCalledWith(
        'taskkill',
        ['/pid', '12345', '/T', '/F'],
        expect.any(Function)
      )
      expect(execFileMock).not.toHaveBeenCalledWith(
        'taskkill',
        ['/pid', '12346', '/T', '/F'],
        expect.any(Function)
      )
    } else {
      expect(commitChild.kill).toHaveBeenCalledWith('SIGKILL')
      expect(pullRequestChild.kill).not.toHaveBeenCalled()
    }

    commitChild.emit('close', null)
    pullRequestChild.stdout.emit(
      'data',
      Buffer.from('{"base":"main","title":"Update README","body":"Details","draft":false}')
    )
    pullRequestChild.emit('close', 0)

    await expect(commit).resolves.toMatchObject({
      exitCode: null,
      timedOut: false,
      canceled: true
    })
    await expect(pullRequest).resolves.toMatchObject({
      exitCode: 0,
      timedOut: false,
      canceled: false
    })
  })

  it('kills the active command when the request aborts', async () => {
    const child = createFakeChild()
    spawnMock.mockReturnValue(child as never)
    const handlers = createHandlers()
    const controller = new AbortController()

    const pending = handlers.get('agent.execNonInteractive')!(
      {
        binary: 'agent',
        args: [],
        cwd: '/repo',
        stdin: null,
        timeoutMs: 5_000
      },
      { clientId: 1, isStale: () => controller.signal.aborted, signal: controller.signal }
    )

    controller.abort()

    if (process.platform === 'win32') {
      expect(execFileMock).toHaveBeenCalledWith(
        'taskkill',
        ['/pid', '12345', '/T', '/F'],
        expect.any(Function)
      )
    } else {
      expect(child.kill).toHaveBeenCalledWith('SIGKILL')
    }

    child.emit('close', null)
    await expect(pending).resolves.toMatchObject({
      exitCode: null,
      timedOut: false,
      canceled: true
    })
    expect(child.stdout.listenerCount('data')).toBe(0)
    expect(child.stderr.listenerCount('data')).toBe(0)
    expect(child.listenerCount('error')).toBe(0)
    expect(child.listenerCount('close')).toBe(0)
  })

  it('cancels a superseded command in the same operation lane', async () => {
    const firstChild = createFakeChild()
    const secondChild = createFakeChild()
    secondChild.pid = 12346
    spawnMock.mockReturnValueOnce(firstChild as never).mockReturnValueOnce(secondChild as never)
    const handlers = createHandlers()

    const first = handlers.get('agent.execNonInteractive')!(
      {
        binary: 'agent',
        args: ['first'],
        cwd: '/repo',
        stdin: null,
        timeoutMs: 5_000,
        operation: 'commit-message'
      },
      requestContext()
    )
    const second = handlers.get('agent.execNonInteractive')!(
      {
        binary: 'agent',
        args: ['second'],
        cwd: '/repo',
        stdin: null,
        timeoutMs: 5_000,
        operation: 'commit-message'
      },
      requestContext()
    )

    if (process.platform === 'win32') {
      expect(execFileMock).toHaveBeenCalledWith(
        'taskkill',
        ['/pid', '12345', '/T', '/F'],
        expect.any(Function)
      )
      expect(execFileMock).not.toHaveBeenCalledWith(
        'taskkill',
        ['/pid', '12346', '/T', '/F'],
        expect.any(Function)
      )
    } else {
      expect(firstChild.kill).toHaveBeenCalledWith('SIGKILL')
      expect(secondChild.kill).not.toHaveBeenCalled()
    }

    await expect(
      handlers.get('agent.cancelExec')!(
        { cwd: '/repo', operation: 'commit-message' },
        requestContext()
      )
    ).resolves.toEqual({ canceled: true })

    if (process.platform === 'win32') {
      expect(execFileMock).toHaveBeenCalledWith(
        'taskkill',
        ['/pid', '12346', '/T', '/F'],
        expect.any(Function)
      )
    } else {
      expect(secondChild.kill).toHaveBeenCalledWith('SIGKILL')
    }

    firstChild.emit('close', null)
    secondChild.emit('close', null)
    await expect(first).resolves.toMatchObject({ canceled: true })
    await expect(second).resolves.toMatchObject({ canceled: true })
  })

  it('reports when cancellation has no matching in-flight command', async () => {
    const handlers = createHandlers()

    await expect(
      handlers.get('agent.cancelExec')!({ cwd: '/repo' }, requestContext())
    ).resolves.toEqual({ canceled: false })
  })

  it('settles timed-out commands even when the killed child does not close', async () => {
    vi.useFakeTimers()
    try {
      const child = createFakeChild()
      spawnMock.mockReturnValue(child as never)
      const handlers = createHandlers()

      const pending = handlers.get('agent.execNonInteractive')!(
        {
          binary: 'agent',
          args: [],
          cwd: '/repo',
          stdin: null,
          timeoutMs: 5_000
        },
        requestContext()
      ) as Promise<AgentExecResult>
      const outcomePromise = pending.then((result) =>
        result.timedOut ? `timed-out:${result.exitCode}` : 'not-timed-out'
      )

      await vi.advanceTimersByTimeAsync(5_000)
      const outcome = await Promise.race([outcomePromise, Promise.resolve('pending')])

      expect(outcome).toBe('timed-out:null')
      if (process.platform === 'win32') {
        expect(execFileMock).toHaveBeenCalledWith(
          'taskkill',
          ['/pid', '12345', '/T', '/F'],
          expect.any(Function)
        )
      } else {
        expect(child.kill).toHaveBeenCalledWith('SIGKILL')
      }
      expect(child.stdout.listenerCount('data')).toBe(0)
      expect(child.stderr.listenerCount('data')).toBe(0)
      expect(child.listenerCount('error')).toBe(0)
      expect(child.listenerCount('close')).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
