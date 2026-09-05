import { exec, spawn } from 'node:child_process'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ChildProcess from 'node:child_process'
import {
  createFakeChild,
  createHandlers,
  requestContext,
  withPlatform
} from './agent-exec-handler-test-harness'

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>()
  return {
    ...actual,
    exec: vi.fn(),
    spawn: vi.fn()
  }
})

const spawnMock = vi.mocked(spawn)
const execMock = vi.mocked(exec)

describe('AgentExecHandler POSIX login-shell PATH fallback', () => {
  beforeEach(() => {
    spawnMock.mockReset()
    execMock.mockReset()
  })

  it('retries a bare binary through the login shell after a direct ENOENT spawn failure', async () => {
    await withPlatform('linux', async () => {
      const directAttempt = createFakeChild()
      const loginShellLookup = createFakeChild()
      const resolvedRetry = createFakeChild()
      spawnMock
        .mockReturnValueOnce(directAttempt as never)
        .mockReturnValueOnce(loginShellLookup as never)
        .mockReturnValueOnce(resolvedRetry as never)
      const handlers = createHandlers()

      const pending = handlers.get('agent.execNonInteractive')!(
        {
          binary: 'opencode',
          args: ['run'],
          cwd: '/repo',
          stdin: 'PROMPT',
          timeoutMs: 5_000,
          env: { SHELL: '/bin/zsh' }
        },
        requestContext()
      )

      directAttempt.emit(
        'error',
        Object.assign(new Error('spawn opencode ENOENT'), { code: 'ENOENT' })
      )
      // Why: the login-shell lookup resolves via a real Promise, so its .then()
      // continuation (which spawns the retry) lands on a later microtask —
      // wait for each spawn to actually happen before driving its fake child.
      await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(2))
      loginShellLookup.stdout.emit('data', Buffer.from('/home/user/.local/bin/opencode\n'))
      loginShellLookup.emit('close', 0)
      await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(3))
      resolvedRetry.stdout.emit('data', Buffer.from('hello'))
      resolvedRetry.emit('close', 0)

      await expect(pending).resolves.toEqual({
        stdout: 'hello',
        stderr: '',
        exitCode: 0,
        timedOut: false,
        canceled: false
      })

      expect(spawnMock).toHaveBeenNthCalledWith(
        2,
        '/bin/zsh',
        ['-lc', "command -v 'opencode'"],
        expect.objectContaining({ stdio: ['ignore', 'pipe', 'ignore'] })
      )
      expect(spawnMock).toHaveBeenNthCalledWith(
        3,
        '/home/user/.local/bin/opencode',
        ['run'],
        expect.objectContaining({
          cwd: '/repo',
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true
        })
      )
      expect(resolvedRetry.stdin.end).toHaveBeenCalledWith('PROMPT')
    })
  })

  it('reports the original ENOENT error when the login shell cannot resolve the binary either', async () => {
    await withPlatform('linux', async () => {
      const directAttempt = createFakeChild()
      const loginShellLookup = createFakeChild()
      spawnMock
        .mockReturnValueOnce(directAttempt as never)
        .mockReturnValueOnce(loginShellLookup as never)
      const handlers = createHandlers()

      const pending = handlers.get('agent.execNonInteractive')!(
        {
          binary: 'opencode',
          args: ['run'],
          cwd: '/repo',
          stdin: null,
          timeoutMs: 5_000
        },
        requestContext()
      )

      directAttempt.emit(
        'error',
        Object.assign(new Error('spawn opencode ENOENT'), { code: 'ENOENT' })
      )
      loginShellLookup.emit('close', 1)

      await expect(pending).resolves.toEqual({
        stdout: '',
        stderr: '',
        exitCode: null,
        timedOut: false,
        spawnError: 'spawn opencode ENOENT'
      })
      expect(spawnMock).toHaveBeenCalledTimes(2)
    })
  })

  it('does not attempt the login-shell fallback for an absolute-path binary', async () => {
    await withPlatform('linux', async () => {
      const directAttempt = createFakeChild()
      spawnMock.mockReturnValueOnce(directAttempt as never)
      const handlers = createHandlers()

      const pending = handlers.get('agent.execNonInteractive')!(
        {
          binary: '/opt/tools/opencode',
          args: ['run'],
          cwd: '/repo',
          stdin: null,
          timeoutMs: 5_000
        },
        requestContext()
      )

      directAttempt.emit(
        'error',
        Object.assign(new Error('spawn /opt/tools/opencode ENOENT'), { code: 'ENOENT' })
      )

      await expect(pending).resolves.toEqual({
        stdout: '',
        stderr: '',
        exitCode: null,
        timedOut: false,
        spawnError: 'spawn /opt/tools/opencode ENOENT'
      })
      expect(spawnMock).toHaveBeenCalledTimes(1)
    })
  })
})
