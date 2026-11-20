import { describe, expect, it } from 'vitest'
import type {
  CodexAppServerConnection,
  CodexAppServerConnectionHandlers
} from '../codex-app-server-connection-types'
import { CodexSharedServerPool } from './codex-shared-server-pool'
import { CODEX_SHARED_LEASE_MAX_QUEUED_FRAMES } from './codex-shared-server-lease'

type FakeServer = {
  pid: number
  handlers: CodexAppServerConnectionHandlers
  requests: { method: string; params?: Record<string, unknown> }[]
  crash: () => void
}

function fakeCodex() {
  const servers: FakeServer[] = []
  let nextThread = 1
  const connect = async (
    _launch: unknown,
    handlers: CodexAppServerConnectionHandlers = {}
  ): Promise<CodexAppServerConnection> => {
    let closed = false
    const server: FakeServer = {
      pid: 5000 + servers.length,
      handlers,
      requests: [],
      crash: () => {
        closed = true
        handlers.onClose?.(new Error('codex crashed'))
        handlers.onExit?.(new Error('codex crashed'), { expected: false })
      }
    }
    servers.push(server)
    return {
      pid: server.pid,
      get closed() {
        return closed
      },
      request: async (method, params, options) => {
        server.requests.push({ method, ...(params ? { params } : {}) })
        let result: unknown = {}
        if (method === 'thread/start') {
          const id = `thread-${nextThread++}`
          // Codex announces the thread before it answers the start.
          handlers.onNotification?.('thread/started', { thread: { id } })
          result = { thread: { id } }
        }
        options?.onReply?.(result)
        return result
      },
      notify: () => {},
      respond: () => {},
      respondWithError: () => {},
      close: async () => {
        closed = true
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
  const result = (await connection.request('thread/start', { cwd: '/work' })) as {
    thread: { id: string }
  }
  return result.thread.id
}

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
    expect(a.exits).toHaveLength(1)
    expect(a.exits[0]?.expected).toBe(false)
    expect(connB.closed).toBe(false)
    expect(b.notifications.at(-1)?.method).toBe('item/started')
  })
})
