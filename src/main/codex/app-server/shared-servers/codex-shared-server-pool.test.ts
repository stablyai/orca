import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  CodexAppServerConnection,
  CodexAppServerConnectionHandlers
} from '../codex-app-server-connection-types'
import { CodexSharedServerPool } from './codex-shared-server-pool'
import { CODEX_SHARED_LEASE_MAX_QUEUED_FRAMES } from './codex-shared-server-lease'
import { codexOpenedThreadId } from './codex-shared-server-frames'
import { codexConnectionOpener } from '../../structured/acquisition/codex-structured-connection-opener'
import { spawnCodexAppServerConnection } from '../codex-app-server-connection'

type FakeServer = {
  pid: number
  handlers: CodexAppServerConnectionHandlers
  requests: { method: string; params?: Record<string, unknown> }[]
  crash: () => void
  /** The server goes unusable without its exit being proven yet. */
  closeTransport: () => void
}

/** interrupt: 'ends' completes the turn at once, 'later' after 3 s, 'ignored' never. */
function fakeCodex(interrupt: 'ends' | 'later' | 'ignored' = 'ends') {
  const servers: FakeServer[] = []
  let nextThread = 1
  const connect = async (
    _launch: unknown,
    handlers: CodexAppServerConnectionHandlers = {}
  ): Promise<CodexAppServerConnection> => {
    let closed = false
    let closeResult: CodexAppServerConnection['closeResult'] = null
    const server: FakeServer = {
      pid: 5000 + servers.length,
      handlers,
      requests: [],
      crash: () => {
        closed = true
        handlers.onClose?.(new Error('codex crashed'))
        handlers.onExit?.(new Error('codex crashed'), { expected: false })
      },
      closeTransport: () => {
        closed = true
        handlers.onClose?.(new Error('broken pipe'))
      }
    }
    servers.push(server)
    return {
      pid: server.pid,
      get closed() {
        return closed
      },
      get closeResult() {
        return closeResult
      },
      request: async (method, params, options) => {
        server.requests.push({ method, ...(params ? { params } : {}) })
        if (method === 'turn/start' && params?.hang === true) {
          // A send Codex has not answered yet.
          return new Promise(() => {})
        }
        let result: unknown = {}
        if (method === 'thread/start') {
          const id = `thread-${nextThread++}`
          // Codex announces the thread before it answers the start.
          handlers.onNotification?.('thread/started', { thread: { id } })
          result = { thread: { id } }
        } else if (method === 'thread/resume') {
          result = { thread: { id: params?.threadId } }
        } else if (method === 'turn/interrupt' && interrupt !== 'ignored') {
          const end = () =>
            handlers.onNotification?.('turn/completed', {
              threadId: params?.threadId,
              turn: { id: params?.turnId, status: 'interrupted' }
            })
          if (interrupt === 'ends') {
            end()
          } else {
            setTimeout(end, 3_000)
          }
        }
        options?.onReply?.(result)
        return result
      },
      notify: () => {},
      respond: () => {},
      respondWithError: () => {},
      close: async () => {
        closed = true
        closeResult = { root: 'exited', tree: 'exited' }
        handlers.onExit?.(new Error('closed'), { expected: true })
        return true
      }
    }
  }
  return { servers, pool: new CodexSharedServerPool(connect) }
}

function chat() {
  const notifications: { method: string; params: unknown }[] = []
  const exits: { message: string; expected: boolean | undefined }[] = []
  const handlers: CodexAppServerConnectionHandlers = {
    onNotification: (method, params) => notifications.push({ method, params }),
    onExit: (error, exit) => exits.push({ message: error.message, expected: exit?.expected })
  }
  return { handlers, notifications, exits }
}

const launch = (home = '/home/a/.codex') => ({
  command: '/usr/local/bin/codex',
  args: ['app-server'],
  cwd: '/work',
  env: { CODEX_HOME: home, ORCA_AGENT_SESSION_ID: `chat-${Math.random()}` }
})

async function startThread(connection: CodexAppServerConnection): Promise<string> {
  const threadId = codexOpenedThreadId(await connection.request('thread/start', { cwd: '/work' }))
  expect(threadId).not.toBeNull()
  return threadId ?? ''
}

afterEach(() => {
  vi.useRealTimers()
})

describe('shared Codex app-servers', () => {
  it('routes each thread to its own chat on one server and copies server-wide frames to all', async () => {
    const { servers, pool } = fakeCodex()
    const a = chat()
    const b = chat()
    const connA = await pool.open(launch(), a.handlers, { sessionId: 'a', skillRoots: [] })
    const connB = await pool.open(launch(), b.handlers, { sessionId: 'b', skillRoots: [] })
    expect(servers).toHaveLength(1)
    const threadA = await startThread(connA)
    const threadB = await startThread(connB)
    const { handlers } = servers[0]!
    handlers.onNotification?.('item/started', { threadId: threadA, item: { id: 'x' } })
    handlers.onNotification?.('item/started', { threadId: threadB, item: { id: 'y' } })
    handlers.onNotification?.('account/rateLimits/updated', { rateLimits: {} })

    expect(a.notifications.map((n) => n.method)).toEqual([
      'thread/started',
      'item/started',
      'account/rateLimits/updated'
    ])
    expect(a.notifications[1]?.params).toEqual({ threadId: 'thread-1', item: { id: 'x' } })
    expect(b.notifications[1]?.params).toEqual({ threadId: 'thread-2', item: { id: 'y' } })
    // One initialize for the server; the chats' own handshakes never reach Codex.
    await connA.request('initialize', {})
    expect(servers[0]!.requests.filter((r) => r.method === 'initialize')).toHaveLength(1)
  })

  it('starts a second server at 20 chats and never shares across account homes', async () => {
    const { servers, pool } = fakeCodex()
    for (let i = 0; i < 21; i += 1) {
      await pool.open(launch(), chat().handlers, { sessionId: `c${i}`, skillRoots: [] })
    }
    expect(servers).toHaveLength(2)
    await pool.open(launch('/home/b/.codex'), chat().handlers, {
      sessionId: 'other-account',
      skillRoots: []
    })
    expect(servers).toHaveLength(3)
  })

  it('ends every chat on a crashed server as an unexpected exit, and the next chat gets a new server', async () => {
    const { servers, pool } = fakeCodex()
    const a = chat()
    const b = chat()
    await pool.open(launch(), a.handlers, { sessionId: 'a', skillRoots: [] })
    await pool.open(launch(), b.handlers, { sessionId: 'b', skillRoots: [] })
    servers[0]!.crash()
    expect(a.exits).toEqual([{ message: 'codex crashed', expected: false }])
    expect(b.exits).toEqual([{ message: 'codex crashed', expected: false }])
    await pool.open(launch(), chat().handlers, { sessionId: 'a', skillRoots: [] })
    expect(servers).toHaveLength(2)
  })

  it('closing a chat interrupts its running turn and unsubscribes its thread, leaving the server up', async () => {
    const { servers, pool } = fakeCodex()
    const a = chat()
    const b = chat()
    const connA = await pool.open(launch(), a.handlers, { sessionId: 'a', skillRoots: [] })
    const connB = await pool.open(launch(), b.handlers, { sessionId: 'b', skillRoots: [] })
    const threadA = await startThread(connA)
    servers[0]!.handlers.onNotification?.('turn/started', {
      threadId: threadA,
      turn: { id: 'turn-1' }
    })
    await expect(connA.close()).resolves.toBe(true)
    expect(servers[0]!.requests.slice(-2)).toEqual([
      { method: 'turn/interrupt', params: { threadId: 'thread-1', turnId: 'turn-1' } },
      { method: 'thread/unsubscribe', params: { threadId: 'thread-1' } }
    ])
    expect(a.exits).toEqual([{ message: 'codex app-server connection closed', expected: true }])
    expect(connB.closed).toBe(false)
  })

  it('drops only a paused chat that falls past its queue bound', async () => {
    const { servers, pool } = fakeCodex()
    const a = chat()
    const b = chat()
    const connA = await pool.open(launch(), a.handlers, { sessionId: 'a', skillRoots: [] })
    const connB = await pool.open(launch(), b.handlers, { sessionId: 'b', skillRoots: [] })
    const threadA = await startThread(connA)
    const threadB = await startThread(connB)
    connA.pauseReading?.()
    for (let i = 0; i <= CODEX_SHARED_LEASE_MAX_QUEUED_FRAMES; i += 1) {
      servers[0]!.handlers.onNotification?.('item/agentMessage/delta', { threadId: threadA })
    }
    servers[0]!.handlers.onNotification?.('item/started', { threadId: threadB })
    await vi.waitFor(() => expect(a.exits).toHaveLength(1))
    expect(a.exits[0]?.expected).toBe(false)
    expect(connB.closed).toBe(false)
    expect(b.notifications.at(-1)?.method).toBe('item/started')
  })

  it('interrupts a turn whose start is still queued behind a paused chat', async () => {
    const { servers, pool } = fakeCodex()
    const a = chat()
    const connA = await pool.open(launch(), a.handlers, { sessionId: 'a', skillRoots: [] })
    const threadA = await startThread(connA)
    connA.pauseReading?.()
    servers[0]!.handlers.onNotification?.('turn/started', {
      threadId: threadA,
      turn: { id: 'turn-q' }
    })
    await connA.close()
    expect(servers[0]!.requests).toContainEqual({
      method: 'turn/interrupt',
      params: { threadId: threadA, turnId: 'turn-q' }
    })
    expect(connA.processTreeUnproven).toBe(false)
  })

  it('reports Stop unproven when the turn ignores the interrupt, stopping a server no other chat is using', async () => {
    vi.useFakeTimers()
    const { servers, pool } = fakeCodex('ignored')
    const connA = await pool.open(launch(), chat().handlers, { sessionId: 'a', skillRoots: [] })
    const idle = await pool.open(launch(), chat().handlers, { sessionId: 'b', skillRoots: [] })
    const threadA = await startThread(connA)
    servers[0]!.handlers.onNotification?.('turn/started', { threadId: threadA, turn: { id: 't' } })
    const closing = connA.close()
    await vi.advanceTimersByTimeAsync(20_000)
    await closing
    expect(connA.processTreeUnproven).toBe(false)
    expect(idle.closed).toBe(true)
    const busy = fakeCodex('ignored')
    const x = await busy.pool.open(launch(), chat().handlers, { sessionId: 'x', skillRoots: [] })
    const y = await busy.pool.open(launch(), chat().handlers, { sessionId: 'y', skillRoots: [] })
    const threadX = await startThread(x)
    const threadY = await startThread(y)
    for (const [threadId, id] of [
      [threadX, 'tx'],
      [threadY, 'ty']
    ] as const) {
      busy.servers[0]!.handlers.onNotification?.('turn/started', { threadId, turn: { id } })
    }
    const closingX = x.close()
    await vi.advanceTimersByTimeAsync(20_000)
    await closingX
    expect(x.processTreeUnproven).toBe(true)
    expect(y.closed).toBe(false)
  })

  it('never unsubscribes a thread a recovering chat already resumed while the old lease was stopping', async () => {
    vi.useFakeTimers()
    const { servers, pool } = fakeCodex('later')
    const a = chat()
    const connA = await pool.open(launch(), a.handlers, { sessionId: 'a', skillRoots: [] })
    const threadA = await startThread(connA)
    servers[0]!.handlers.onNotification?.('turn/started', { threadId: threadA, turn: { id: 't' } })
    connA.pauseReading?.()
    for (let i = 0; i <= CODEX_SHARED_LEASE_MAX_QUEUED_FRAMES; i += 1) {
      servers[0]!.handlers.onNotification?.('item/agentMessage/delta', { threadId: threadA })
    }
    // The chat hears its exit only once its turn is stopped.
    expect(a.exits).toEqual([])
    const replacement = await pool.open(launch(), chat().handlers, {
      sessionId: 'a',
      skillRoots: []
    })
    await replacement.request('thread/resume', { threadId: threadA })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(a.exits).toHaveLength(1)
    expect(servers[0]!.requests).not.toContainEqual({
      method: 'thread/unsubscribe',
      params: { threadId: threadA }
    })
  })

  it('starts a fresh server once the current one can no longer take requests', async () => {
    const { servers, pool } = fakeCodex()
    await pool.open(launch(), chat().handlers, { sessionId: 'a', skillRoots: [] })
    servers[0]!.closeTransport()
    await pool.open(launch(), chat().handlers, { sessionId: 'b', skillRoots: [] })
    expect(servers).toHaveLength(2)
  })

  it('waits on the cleanup already running when a chat is closed while being dropped', async () => {
    vi.useFakeTimers()
    const { servers, pool } = fakeCodex('later')
    const a = chat()
    const connA = await pool.open(launch(), a.handlers, { sessionId: 'a', skillRoots: [] })
    const threadA = await startThread(connA)
    servers[0]!.handlers.onNotification?.('turn/started', { threadId: threadA, turn: { id: 't' } })
    connA.pauseReading?.()
    for (let i = 0; i <= CODEX_SHARED_LEASE_MAX_QUEUED_FRAMES; i += 1) {
      servers[0]!.handlers.onNotification?.('item/agentMessage/delta', { threadId: threadA })
    }
    let closed = false
    void connA.close().then(() => {
      closed = true
    })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(closed).toBe(false)
    await vi.advanceTimersByTimeAsync(3_000)
    expect(closed).toBe(true)
    expect(connA.processTreeUnproven).toBe(false)
    expect(a.exits).toHaveLength(1)
  })

  it('proves a chat stopped on a broken transport only by stopping that server', async () => {
    const { servers, pool } = fakeCodex()
    const connA = await pool.open(launch(), chat().handlers, { sessionId: 'a', skillRoots: [] })
    const threadA = await startThread(connA)
    servers[0]!.handlers.onNotification?.('turn/started', { threadId: threadA, turn: { id: 't' } })
    servers[0]!.closeTransport()
    await connA.close()
    expect(connA.closeResult).toEqual({ root: 'exited', tree: 'exited' })
    expect(servers[0]!.requests.map((r) => r.method)).not.toContain('turn/interrupt')
  })

  it("keeps a server up for another chat's unanswered send when a stuck turn is stopped", async () => {
    vi.useFakeTimers()
    const { servers, pool } = fakeCodex('ignored')
    const connA = await pool.open(launch(), chat().handlers, { sessionId: 'a', skillRoots: [] })
    const connB = await pool.open(launch(), chat().handlers, { sessionId: 'b', skillRoots: [] })
    const threadA = await startThread(connA)
    const threadB = await startThread(connB)
    servers[0]!.handlers.onNotification?.('turn/started', { threadId: threadA, turn: { id: 't' } })
    void connB.request('turn/start', { threadId: threadB, hang: true })
    const closing = connA.close()
    await vi.advanceTimersByTimeAsync(20_000)
    await closing
    expect(connA.processTreeUnproven).toBe(true)
    expect(connB.closed).toBe(false)
  })

  it('never shares a server for a custom Codex command', () => {
    const opener = codexConnectionOpener({ sharedServers: () => true }, 's', {
      customCommand: true
    })
    expect(opener).toBe(spawnCodexAppServerConnection)
  })
})
