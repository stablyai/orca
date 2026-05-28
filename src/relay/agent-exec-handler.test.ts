import { EventEmitter } from 'events'
import { exec, spawn } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ChildProcess from 'child_process'
import type { MethodHandler, RequestContext } from './dispatcher'
import { AgentExecHandler } from './agent-exec-handler'

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

function withPlatform<T>(platform: NodeJS.Platform, fn: () => T): T {
  const original = process.platform
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
  try {
    return fn()
  } finally {
    Object.defineProperty(process, 'platform', { configurable: true, value: original })
  }
}

type FakeChild = EventEmitter & {
  pid: number
  kill: ReturnType<typeof vi.fn>
  stdout: EventEmitter
  stderr: EventEmitter
  stdin: { end: ReturnType<typeof vi.fn> }
}

function createFakeChild(): FakeChild {
  return Object.assign(new EventEmitter(), {
    pid: 12345,
    kill: vi.fn(),
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    stdin: { end: vi.fn() }
  })
}

function createHandlers(): Map<string, MethodHandler> {
  const handlers = new Map<string, MethodHandler>()
  new AgentExecHandler({
    onRequest: (method: string, handler: MethodHandler): void => {
      handlers.set(method, handler)
    }
  } as never)
  return handlers
}

function requestContext(clientId = 1): RequestContext {
  return { clientId, isStale: () => false }
}

describe('AgentExecHandler', () => {
  beforeEach(() => {
    spawnMock.mockReset()
    execMock.mockReset()
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

  it('resolves bare Windows agent commands to batch shims before spawning', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'orca-agent-exec-'))
    const originalComSpec = process.env.ComSpec
    process.env.ComSpec = 'C:\\Windows\\System32\\cmd.exe'
    try {
      await withPlatform('win32', async () => {
        const codexShim = join(tempDir, 'codex.cmd')
        writeFileSync(codexShim, '@echo off\r\n')
        const child = createFakeChild()
        spawnMock.mockReturnValue(child as never)
        const handlers = createHandlers()

        const pending = handlers.get('agent.execNonInteractive')!(
          {
            binary: 'codex',
            args: ['exec', '-s', 'read-only'],
            cwd: 'C:\\repo',
            stdin: 'PROMPT',
            timeoutMs: 5_000,
            env: { PATH: tempDir }
          },
          requestContext()
        )

        child.emit('close', 0)

        await expect(pending).resolves.toMatchObject({
          exitCode: 0,
          timedOut: false
        })
        expect(spawnMock).toHaveBeenCalledWith(
          'C:\\Windows\\System32\\cmd.exe',
          ['/d', '/s', '/c', `"${codexShim}" "exec" "-s" "read-only"`],
          {
            cwd: 'C:\\repo',
            env: expect.objectContaining({ PATH: tempDir }),
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true
          }
        )
      })
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
      if (originalComSpec === undefined) {
        delete process.env.ComSpec
      } else {
        process.env.ComSpec = originalComSpec
      }
    }
  })

  it('rejects unsafe args when routing Windows batch shims through cmd.exe', async () => {
    await withPlatform('win32', async () => {
      const handlers = createHandlers()

      const result = await handlers.get('agent.execNonInteractive')!(
        {
          binary: 'C:\\tools\\agent.cmd',
          args: ['hello & goodbye'],
          cwd: 'C:\\repo',
          stdin: null,
          timeoutMs: 5_000
        },
        requestContext()
      )

      expect(result).toEqual({
        stdout: '',
        stderr: '',
        exitCode: null,
        timedOut: false,
        spawnError: 'UNSAFE_WINDOWS_BATCH_ARGUMENTS'
      })
      expect(spawnMock).not.toHaveBeenCalled()
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

  it('reports when cancellation has no matching in-flight command', async () => {
    const handlers = createHandlers()

    await expect(
      handlers.get('agent.cancelExec')!({ cwd: '/repo' }, requestContext())
    ).resolves.toEqual({ canceled: false })
  })
})
