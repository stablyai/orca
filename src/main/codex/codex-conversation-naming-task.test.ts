import { afterEach, describe, expect, it, vi } from 'vitest'
import { CodexConversationNamingTask } from './codex-conversation-naming-task'
import type {
  CodexAppServerConnection,
  CodexAppServerConnectionHandlers,
  openCodexAppServerConnection
} from './codex-app-server-connection'
import { CodexAppServerHandshakeExitUnprovenError } from './codex-app-server-handshake-exit-proof'

function fixture(
  options: {
    hold?: 'handshake' | 'thread/start' | 'turn/start'
    closeProven?: boolean
    handshakeFails?: boolean
  } = {}
) {
  let handlers: CodexAppServerConnectionHandlers = {}
  let finishHandshake = (): void => {}
  const handshake = new Promise<void>((resolve) => {
    finishHandshake = resolve
  })
  const close = vi.fn(async () => {
    finishHandshake()
    return options.closeProven ?? true
  })
  const connection: CodexAppServerConnection = {
    pid: 123,
    closed: false,
    close,
    notify: vi.fn(),
    respond: vi.fn(),
    respondWithError: vi.fn(),
    request: vi.fn(async (method) => {
      if (method === options.hold) {
        return new Promise<never>(() => {})
      }
      if (method === 'config/read') {
        return { config: {} }
      }
      if (method === 'thread/start') {
        return { thread: { id: 'naming', ephemeral: true } }
      }
      if (method === 'turn/start') {
        handlers.onNotification?.('item/completed', {
          item: { type: 'agentMessage', text: '{"title":"Fix probe"}' }
        })
        handlers.onNotification?.('turn/completed', {})
      }
      return {}
    })
  }
  const openConnection = vi.fn(async (_launch, callbacks = {}) => {
    handlers = callbacks
    handlers.onConnection?.(connection)
    if (options.hold === 'handshake') {
      await handshake
    }
    if (options.handshakeFails) {
      throw new CodexAppServerHandshakeExitUnprovenError(connection, new Error('handshake'))
    }
    return connection
  }) as unknown as typeof openCodexAppServerConnection
  const userConnection = { request: vi.fn(async () => ({ thread: { id: 'user' } })) }
  const create = () =>
    new CodexConversationNamingTask({
      launch: {
        command: 'codex',
        args: ['app-server'],
        cwd: '/folder',
        env: { CODEX_HOME: '/account', CUSTOM: 'inherited' }
      },
      openConnection,
      timeoutMs: 1000,
      generation: {
        userConnection,
        cwd: '/folder',
        threadId: 'user',
        prompt: 'fix probe',
        model: 'selected'
      }
    })
  return { create, close, connection, openConnection, userConnection, handlers: () => handlers }
}

async function settle() {
  for (let i = 0; i < 20; i += 1) {
    await Promise.resolve()
  }
}
afterEach(() => vi.useRealTimers())

describe('Codex naming process lifecycle', () => {
  it('reaps a successful separate process and preserves account and launch settings', async () => {
    const f = fixture()
    const task = f.create()
    await expect(task.result).resolves.toEqual({ name: 'Fix probe', settled: true })
    expect(f.close).toHaveBeenCalled()
    expect(f.openConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: '/folder',
        command: 'codex',
        args: ['app-server'],
        env: expect.objectContaining({ CODEX_HOME: '/account', CUSTOM: 'inherited' })
      }),
      expect.anything()
    )
  })

  it.each(['handshake', 'thread/start', 'turn/start'] as const)(
    'deadline cancels and reaps a stalled %s',
    async (hold) => {
      vi.useFakeTimers()
      const f = fixture({ hold })
      const task = f.create()
      const result = task.result.catch(() => null)
      await settle()
      await vi.advanceTimersByTimeAsync(1000)
      try {
        expect(f.close).toHaveBeenCalled()
      } finally {
        await task.close()
        await result
      }
      expect(f.userConnection.request).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it('retains unproven acquisition cleanup for an explicit retry', async () => {
    const f = fixture({ handshakeFails: true, closeProven: false })
    const task = f.create()
    await expect(task.result).rejects.toThrow('handshake failed')
    await expect(task.close()).resolves.toBe(false)
    f.close.mockResolvedValue(true)
    await expect(task.close()).resolves.toBe(true)
    expect(f.close).toHaveBeenCalledTimes(3)
  })

  it('close during generation prevents publishing a late answer', async () => {
    const f = fixture({ hold: 'turn/start' })
    const task = f.create()
    const result = task.result.catch(() => null)
    await settle()
    await expect(task.close()).resolves.toBe(true)
    f.handlers().onNotification?.('item/completed', {
      item: { type: 'agentMessage', text: '{"title":"Late"}' }
    })
    f.handlers().onNotification?.('turn/completed', {})
    await result
    expect(f.userConnection.request).not.toHaveBeenCalled()
  })

  it('refuses any server request on the naming process without thread attribution', async () => {
    const f = fixture({ hold: 'thread/start' })
    const task = f.create()
    const result = task.result.catch(() => null)
    f.handlers().onServerRequest?.({
      id: 77,
      method: 'item/commandExecution/requestApproval',
      params: {}
    })
    expect(f.connection.respondWithError).toHaveBeenCalledWith(77, -32001, expect.any(String))
    await task.close()
    await result
  })
})
