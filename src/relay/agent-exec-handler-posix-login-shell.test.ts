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

  it('runs the login-shell lookup with the execution environment, not the relay PATH', async () => {
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
          args: [],
          cwd: '/repo',
          stdin: null,
          timeoutMs: 5_000,
          env: { SHELL: '/bin/zsh', PATH: '/opt/agents/bin' }
        },
        requestContext()
      )

      directAttempt.emit(
        'error',
        Object.assign(new Error('spawn opencode ENOENT'), { code: 'ENOENT' })
      )
      await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(2))
      loginShellLookup.stdout.emit('data', Buffer.from('/opt/agents/bin/opencode\n'))
      loginShellLookup.emit('close', 0)
      await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(3))
      resolvedRetry.emit('close', 0)
      await pending

      // The lookup answers for whichever PATH it runs under, so it has to run
      // under the same env as the retry exec.
      const lookupOptions = spawnMock.mock.calls[1]?.[2] as { env?: NodeJS.ProcessEnv }
      const retryOptions = spawnMock.mock.calls[2]?.[2] as { env?: NodeJS.ProcessEnv }
      expect(lookupOptions.env).toBeDefined()
      expect(lookupOptions.env?.PATH).toBe('/opt/agents/bin')
      expect(lookupOptions.env).toEqual(retryOptions.env)
    })
  })

  it('takes the resolved path from the last line when a login profile prints first', async () => {
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
          args: [],
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
      await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(2))
      // A profile that greets on login lands ahead of `command -v`'s answer.
      loginShellLookup.stdout.emit(
        'data',
        Buffer.from('Welcome to build-box 3\nnvm: using v22.23.2\n/home/user/.local/bin/opencode\n')
      )
      loginShellLookup.emit('close', 0)
      await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(3))
      resolvedRetry.emit('close', 0)
      await pending

      expect(spawnMock).toHaveBeenNthCalledWith(
        3,
        '/home/user/.local/bin/opencode',
        [],
        expect.anything()
      )
    })
  })

  it('refuses a lookup result that is not an absolute path', async () => {
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
          args: [],
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
      await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(2))
      // What `command -v` prints for an alias — spawning this would run the
      // literal text as a binary name.
      loginShellLookup.stdout.emit('data', Buffer.from("alias opencode='opencode --oneshot'\n"))
      loginShellLookup.emit('close', 0)

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

  it('kills the lookup and gives up once it has printed more than it should', async () => {
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
          args: [],
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
      await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(2))
      loginShellLookup.stdout.emit('data', Buffer.from('x'.repeat(64 * 1024 + 1)))

      await expect(pending).resolves.toEqual({
        stdout: '',
        stderr: '',
        exitCode: null,
        timedOut: false,
        spawnError: 'spawn opencode ENOENT'
      })
      expect(loginShellLookup.kill).toHaveBeenCalledWith('SIGKILL')
    })
  })

  it('cancels the lookup instead of waiting for it when the request aborts', async () => {
    await withPlatform('linux', async () => {
      const directAttempt = createFakeChild()
      const loginShellLookup = createFakeChild()
      spawnMock
        .mockReturnValueOnce(directAttempt as never)
        .mockReturnValueOnce(loginShellLookup as never)
      const handlers = createHandlers()
      const controller = new AbortController()

      const pending = handlers.get('agent.execNonInteractive')!(
        {
          binary: 'opencode',
          args: [],
          cwd: '/repo',
          stdin: null,
          timeoutMs: 5_000
        },
        { ...requestContext(), signal: controller.signal }
      )

      directAttempt.emit(
        'error',
        Object.assign(new Error('spawn opencode ENOENT'), { code: 'ENOENT' })
      )
      await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(2))
      // The lookup never answers. Without cancellation reaching it, this exec
      // sits here until the resolver's own five-second timer fires.
      controller.abort()

      await expect(pending).resolves.toEqual({
        stdout: '',
        stderr: '',
        exitCode: null,
        timedOut: false,
        canceled: true
      })
      expect(loginShellLookup.kill).toHaveBeenCalledWith('SIGKILL')
    })
  })

  it('asks the login shell from the requested execution directory', async () => {
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
          args: [],
          cwd: '/repo/packages/api',
          stdin: null,
          timeoutMs: 5_000
        },
        requestContext()
      )

      directAttempt.emit(
        'error',
        Object.assign(new Error('spawn opencode ENOENT'), { code: 'ENOENT' })
      )
      await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(2))
      loginShellLookup.stdout.emit(
        'data',
        Buffer.from('/repo/packages/api/node_modules/.bin/opencode\n')
      )
      loginShellLookup.emit('close', 0)
      await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(3))
      resolvedRetry.emit('close', 0)
      await pending

      // A login profile can answer per directory (direnv, .nvmrc), so the
      // lookup has to run where the retry will.
      const lookupOptions = spawnMock.mock.calls[1]?.[2] as { cwd?: string }
      expect(lookupOptions.cwd).toBe('/repo/packages/api')
    })
  })

  it('signals the whole lookup process group, not just the shell', async () => {
    await withPlatform('linux', async () => {
      const directAttempt = createFakeChild()
      const loginShellLookup = createFakeChild()
      spawnMock
        .mockReturnValueOnce(directAttempt as never)
        .mockReturnValueOnce(loginShellLookup as never)
      const handlers = createHandlers()
      const controller = new AbortController()
      const killSpy = vi.spyOn(process, 'kill').mockImplementation((() => true) as never)

      try {
        const pending = handlers.get('agent.execNonInteractive')!(
          {
            binary: 'opencode',
            args: [],
            cwd: '/repo',
            stdin: null,
            timeoutMs: 5_000
          },
          { ...requestContext(), signal: controller.signal }
        )

        directAttempt.emit(
          'error',
          Object.assign(new Error('spawn opencode ENOENT'), { code: 'ENOENT' })
        )
        await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(2))
        controller.abort()
        await pending

        // detached: true makes the shell a group leader; the negative pid is
        // what reaches anything its profile backgrounded.
        expect(spawnMock.mock.calls[1]?.[2]).toMatchObject({ detached: true })
        expect(killSpy).toHaveBeenCalledWith(-loginShellLookup.pid, 'SIGKILL')
      } finally {
        killSpy.mockRestore()
      }
    })
  })
})
