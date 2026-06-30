import { exec, spawn } from 'child_process'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ChildProcess from 'child_process'
import type * as Os from 'os'

const { execFileAsyncMock, userInfoMock } = vi.hoisted(() => ({
  execFileAsyncMock: vi.fn(),
  userInfoMock: vi.fn<() => { shell: string | null }>(() => ({ shell: null }))
}))

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof Os>()
  return {
    ...actual,
    userInfo: userInfoMock
  }
})

import {
  createFakeChild,
  createHandlers,
  requestContext,
  withPlatform
} from './agent-exec-handler-test-harness'
import {
  _resetRelayCommandPathCacheForTests,
  resolveCommandLaunchForRelay
} from './relay-command-path-lookup'

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>()
  const execFileWithPromisify = Object.assign(vi.fn(), {
    [Symbol.for('nodejs.util.promisify.custom')]: execFileAsyncMock
  })
  return {
    ...actual,
    exec: vi.fn(),
    execFile: execFileWithPromisify,
    spawn: vi.fn()
  }
})

const spawnMock = vi.mocked(spawn)
const execMock = vi.mocked(exec)

type AgentExecResult = { exitCode: number | null; timedOut: boolean }

async function withShell<T>(shell: string | undefined, fn: () => Promise<T>): Promise<T> {
  const originalShell = process.env.SHELL
  if (shell === undefined) {
    delete process.env.SHELL
  } else {
    process.env.SHELL = shell
  }
  try {
    return await fn()
  } finally {
    if (originalShell === undefined) {
      delete process.env.SHELL
    } else {
      process.env.SHELL = originalShell
    }
  }
}

describe('AgentExecHandler', () => {
  beforeEach(() => {
    spawnMock.mockReset()
    execMock.mockReset()
    execFileAsyncMock.mockReset()
    _resetRelayCommandPathCacheForTests()
    userInfoMock.mockReset()
    userInfoMock.mockReturnValue({ shell: null })
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
      env: process.env,
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

  it('tries the inherited PATH before shell fallback when shell PATH resolution is requested', async () => {
    await withShell('/bin/bash', async () => {
      await withPlatform('linux', async () => {
        const child = createFakeChild()
        spawnMock.mockReturnValue(child as never)
        const handlers = createHandlers()

        const pending = handlers.get('agent.execNonInteractive')!(
          {
            binary: 'opencode',
            args: ['run'],
            cwd: '/repo',
            stdin: 'PROMPT',
            timeoutMs: 5_000,
            shell: true
          },
          requestContext()
        )

        child.emit('close', 0)

        await expect(pending).resolves.toMatchObject({
          exitCode: 0,
          timedOut: false
        })
        expect(spawnMock).toHaveBeenCalledWith('opencode', ['run'], {
          cwd: '/repo',
          env: process.env,
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true
        })
        expect(spawnMock).toHaveBeenCalledTimes(1)
        expect(child.stdin.end).toHaveBeenCalledWith('PROMPT')
      })
    })
  })

  it('resolves through the explicit POSIX shell when inherited PATH misses the agent', async () => {
    await withShell('/bin/bash', async () => {
      await withPlatform('linux', async () => {
        const directChild = createFakeChild()
        const resolvedChild = createFakeChild()
        spawnMock
          .mockReturnValueOnce(directChild as never)
          .mockReturnValueOnce(resolvedChild as never)
        execFileAsyncMock.mockResolvedValueOnce({
          stdout:
            '__ORCA_AGENT_PATH__/home/test/.nvm/versions/node/v22/bin/opencode\n' +
            '__ORCA_AGENT_ENV_PATH__/home/test/.nvm/versions/node/v22/bin:/usr/bin\n'
        })
        const handlers = createHandlers()

        const pending = handlers.get('agent.execNonInteractive')!(
          {
            binary: 'opencode',
            args: ['run', '--model', 'opencode/deepseek-v4-flash-free'],
            cwd: '/repo',
            stdin: 'PROMPT',
            timeoutMs: 5_000,
            shell: true
          },
          requestContext()
        )

        directChild.emit(
          'error',
          Object.assign(new Error('spawn opencode ENOENT'), { code: 'ENOENT' })
        )
        await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(2))
        resolvedChild.emit('close', 0)

        await expect(pending).resolves.toMatchObject({
          exitCode: 0,
          timedOut: false
        })
        expect(spawnMock).toHaveBeenNthCalledWith(
          1,
          'opencode',
          ['run', '--model', 'opencode/deepseek-v4-flash-free'],
          {
            cwd: '/repo',
            env: process.env,
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true
          }
        )
        expect(spawnMock).toHaveBeenNthCalledWith(
          2,
          '/home/test/.nvm/versions/node/v22/bin/opencode',
          ['run', '--model', 'opencode/deepseek-v4-flash-free'],
          {
            cwd: '/repo',
            env: expect.objectContaining({
              ...process.env,
              PATH: '/home/test/.nvm/versions/node/v22/bin:/usr/bin'
            }),
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true
          }
        )
        expect(execFileAsyncMock).toHaveBeenCalledWith(
          '/bin/bash',
          [
            '-ilc',
            [
              "if resolved=$(command -v 'opencode' 2>/dev/null); then",
              'printf \'__ORCA_AGENT_PATH__%s\\n\' "$resolved"',
              'printf \'__ORCA_AGENT_ENV_PATH__%s\\n\' "$PATH"',
              'fi'
            ].join('\n')
          ],
          {
            encoding: 'utf-8',
            env: expect.objectContaining({ SHELL: '/bin/bash' }),
            timeout: 5000
          }
        )
        expect(directChild.stdin.end).toHaveBeenCalledWith('PROMPT')
        expect(resolvedChild.stdin.end).toHaveBeenCalledWith('PROMPT')
      })
    })
  })

  it('resolves through the account login shell when SHELL is unset', async () => {
    userInfoMock.mockReturnValue({ shell: '/bin/zsh' })
    await withShell(undefined, async () => {
      await withPlatform('linux', async () => {
        const directChild = createFakeChild()
        const resolvedChild = createFakeChild()
        spawnMock
          .mockReturnValueOnce(directChild as never)
          .mockReturnValueOnce(resolvedChild as never)
        execFileAsyncMock.mockResolvedValueOnce({
          stdout:
            '__ORCA_AGENT_PATH__/Users/test/.local/bin/opencode\n' +
            '__ORCA_AGENT_ENV_PATH__/Users/test/.local/bin:/usr/bin\n'
        })
        const handlers = createHandlers()

        const pending = handlers.get('agent.execNonInteractive')!(
          {
            binary: 'opencode',
            args: ['run'],
            cwd: '/repo',
            stdin: null,
            timeoutMs: 5_000,
            shell: true
          },
          requestContext()
        )

        directChild.emit(
          'error',
          Object.assign(new Error('spawn opencode ENOENT'), { code: 'ENOENT' })
        )
        await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(2))
        resolvedChild.emit('close', 0)

        await expect(pending).resolves.toMatchObject({
          exitCode: 0,
          timedOut: false
        })
        expect(execFileAsyncMock).toHaveBeenCalledWith(
          '/bin/zsh',
          expect.arrayContaining(['-ilc']),
          expect.objectContaining({
            encoding: 'utf-8',
            timeout: 5000
          })
        )
        expect(spawnMock).toHaveBeenNthCalledWith(2, '/Users/test/.local/bin/opencode', ['run'], {
          cwd: '/repo',
          env: expect.objectContaining({
            ...process.env,
            PATH: '/Users/test/.local/bin:/usr/bin'
          }),
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true
        })
      })
    })
  })

  it('does not run shell fallback when the configured shell is missing or unsupported', async () => {
    for (const shell of [undefined, '/usr/bin/fish']) {
      await withShell(shell, async () => {
        await withPlatform('linux', async () => {
          const child = createFakeChild()
          spawnMock.mockReturnValue(child as never)
          const handlers = createHandlers()

          const pending = handlers.get('agent.execNonInteractive')!(
            {
              binary: 'opencode',
              args: ['run'],
              cwd: '/repo',
              stdin: null,
              timeoutMs: 5_000,
              shell: true
            },
            requestContext()
          )

          child.emit('error', Object.assign(new Error('spawn opencode ENOENT'), { code: 'ENOENT' }))

          await expect(pending).resolves.toMatchObject({
            exitCode: null,
            timedOut: false,
            spawnError: 'spawn opencode ENOENT'
          })
          expect(spawnMock).toHaveBeenCalledWith('opencode', ['run'], {
            cwd: '/repo',
            env: process.env,
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true
          })
          expect(spawnMock).toHaveBeenCalledTimes(1)
          expect(execFileAsyncMock).not.toHaveBeenCalled()
        })
      })
      spawnMock.mockReset()
      execFileAsyncMock.mockReset()
    }
  })

  it('uses a preflight-cached path without a generation-time shell lookup', async () => {
    await withShell('/usr/bin/fish', async () => {
      await withPlatform('linux', async () => {
        const env = { SHELL: '/usr/bin/fish', PATH: '/usr/bin' }
        execFileAsyncMock.mockResolvedValueOnce({
          stdout:
            '__ORCA_AGENT_PATH__/home/test/.local/bin/opencode\n' +
            '__ORCA_AGENT_ENV_PATH__/home/test/.local/bin:/usr/bin\n'
        })

        await resolveCommandLaunchForRelay('opencode', {
          platform: 'linux',
          env,
          accountLoginShell: null
        })
        execFileAsyncMock.mockClear()

        const directChild = createFakeChild()
        const resolvedChild = createFakeChild()
        spawnMock
          .mockReturnValueOnce(directChild as never)
          .mockReturnValueOnce(resolvedChild as never)
        const handlers = createHandlers()

        const pending = handlers.get('agent.execNonInteractive')!(
          {
            binary: 'opencode',
            args: ['run'],
            cwd: '/repo',
            stdin: 'PROMPT',
            timeoutMs: 5_000,
            env,
            shell: true
          },
          requestContext()
        )

        directChild.emit(
          'error',
          Object.assign(new Error('spawn opencode ENOENT'), { code: 'ENOENT' })
        )
        await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(2))
        resolvedChild.emit('close', 0)

        await expect(pending).resolves.toMatchObject({
          exitCode: 0,
          timedOut: false
        })
        expect(execFileAsyncMock).not.toHaveBeenCalled()
        expect(spawnMock).toHaveBeenNthCalledWith(2, '/home/test/.local/bin/opencode', ['run'], {
          cwd: '/repo',
          env: expect.objectContaining({
            ...process.env,
            PATH: '/home/test/.local/bin:/usr/bin',
            SHELL: '/usr/bin/fish'
          }),
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true
        })
      })
    })
  })

  it('cancels while resolving the fallback path without spawning the resolved agent', async () => {
    await withShell('/bin/bash', async () => {
      await withPlatform('linux', async () => {
        let resolveLookup!: (value: { stdout: string }) => void
        execFileAsyncMock.mockReturnValueOnce(
          new Promise((resolve) => {
            resolveLookup = resolve
          })
        )
        const directChild = createFakeChild()
        spawnMock.mockReturnValueOnce(directChild as never)
        const handlers = createHandlers()

        const pending = handlers.get('agent.execNonInteractive')!(
          {
            binary: 'opencode',
            args: ['run'],
            cwd: '/repo',
            stdin: null,
            timeoutMs: 5_000,
            shell: true
          },
          requestContext()
        )

        directChild.emit(
          'error',
          Object.assign(new Error('spawn opencode ENOENT'), { code: 'ENOENT' })
        )
        await vi.waitFor(() => expect(execFileAsyncMock).toHaveBeenCalledTimes(1))

        await expect(
          handlers.get('agent.cancelExec')!({ cwd: '/repo' }, requestContext())
        ).resolves.toEqual({ canceled: true })
        await expect(pending).resolves.toMatchObject({
          exitCode: null,
          timedOut: false,
          canceled: true
        })

        resolveLookup({
          stdout:
            '__ORCA_AGENT_PATH__/home/test/.local/bin/opencode\n' +
            '__ORCA_AGENT_ENV_PATH__/home/test/.local/bin:/usr/bin\n'
        })
        await Promise.resolve()
        expect(spawnMock).toHaveBeenCalledTimes(1)
      })
    })
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
      expect(execMock).toHaveBeenCalledWith('taskkill /pid 12345 /T /F', expect.any(Function))
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
      expect(execMock).toHaveBeenCalledWith('taskkill /pid 12345 /T /F', expect.any(Function))
      expect(execMock).not.toHaveBeenCalledWith('taskkill /pid 12346 /T /F', expect.any(Function))
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
      expect(execMock).toHaveBeenCalledWith('taskkill /pid 12345 /T /F', expect.any(Function))
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
      expect(execMock).toHaveBeenCalledWith('taskkill /pid 12345 /T /F', expect.any(Function))
      expect(execMock).not.toHaveBeenCalledWith('taskkill /pid 12346 /T /F', expect.any(Function))
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
      expect(execMock).toHaveBeenCalledWith('taskkill /pid 12346 /T /F', expect.any(Function))
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
        expect(execMock).toHaveBeenCalledWith('taskkill /pid 12345 /T /F', expect.any(Function))
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
