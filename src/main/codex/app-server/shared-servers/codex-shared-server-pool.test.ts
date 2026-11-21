import { afterEach, describe, expect, it, vi } from 'vitest'
import { CodexAppServerUnsupportedError } from '../codex-app-server-request-error'
import type {
  CodexAppServerConnection,
  CodexAppServerConnectionHandlers
} from '../codex-app-server-connection-types'
import { CodexSharedServerPool } from './codex-shared-server-pool'
import { CODEX_SHARED_LEASE_MAX_QUEUED_FRAMES } from './codex-shared-server-lease'
import { codexOpenedThreadId } from './codex-shared-server-frames'
import {
  codexConnectionOpener,
  opensSharedCodexServer
} from '../../structured/acquisition/codex-structured-connection-opener'
import { spawnCodexAppServerConnection } from '../codex-app-server-connection'

type FakeServer = {
  pid: number
  handlers: CodexAppServerConnectionHandlers
  requests: { method: string; params?: Record<string, unknown> }[]
  /** Background terminals per thread, as Codex lists them. */
  terminals: Map<string, Set<string>>
  /** Whether Orca stopped reading this server's output. */
  readingPaused: boolean
  /** Answers the thread/start held by `holdOpen`. */
  releaseOpen: () => void
  crash: () => void
  /** The server goes unusable without its exit being proven yet. */
  closeTransport: () => void
}

/** interrupt: 'ends' completes the turn at once, 'later' after 3 s, 'ignored' never. */
function fakeCodex(
  interrupt: 'ends' | 'later' | 'ignored' = 'ends',
  /** What closing the process proves about its commands. */
  closeTree: 'exited' | 'unverifiable' = 'exited',
  /** Whether thread/backgroundTerminals/terminate actually stops the command. */
  terminateWorks = true,
  codex: { listUnsupported?: boolean; unsubscribeFails?: boolean } = {}
) {
  const servers: FakeServer[] = []
  let nextThread = 1
  const connect = async (
    _launch: unknown,
    handlers: CodexAppServerConnectionHandlers = {}
  ): Promise<CodexAppServerConnection> => {
    let closed = false
    let closeResult: CodexAppServerConnection['closeResult'] = null
    const held: (() => void)[] = []
    const server: FakeServer = {
      pid: 5000 + servers.length,
      handlers,
      requests: [],
      terminals: new Map(),
      readingPaused: false,
      releaseOpen: () => {},
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
        // A paused reader gets no replies, as on a real pipe.
        while (server.readingPaused) {
          await new Promise<void>((resume) => held.push(resume))
        }
        server.requests.push({ method, ...(params ? { params } : {}) })
        if (method === 'turn/start' && params?.hang === true) {
          // A send Codex has not answered yet.
          return new Promise(() => {})
        }
        if (
          (method === 'thread/start' || method === 'thread/resume') &&
          params?.holdOpen === true
        ) {
          const id =
            typeof params.threadId === 'string' ? params.threadId : `thread-${nextThread++}`
          return new Promise((resolve) => {
            server.releaseOpen = () => {
              const result = { thread: { id } }
              options?.onReply?.(result)
              resolve(result)
            }
          })
        }
        const threadId = typeof params?.threadId === 'string' ? params.threadId : ''
        if (method === 'thread/resume' && params?.gone === true) {
          throw new Error('codex app-server thread/resume failed: no rollout found')
        }
        if (method === 'thread/backgroundTerminals/list' && codex.listUnsupported) {
          throw new CodexAppServerUnsupportedError('codex app-server does not support list')
        }
        if (method === 'thread/unsubscribe' && codex.unsubscribeFails) {
          throw new Error('codex app-server thread/unsubscribe failed')
        }
        if (method === 'thread/backgroundTerminals/list') {
          const running = [...(server.terminals.get(threadId) ?? [])]
          const result = { data: running.map((processId) => ({ processId })), nextCursor: null }
          options?.onReply?.(result)
          return result
        }
        if (method === 'thread/backgroundTerminals/terminate' && terminateWorks) {
          server.terminals.get(threadId)?.delete(String(params?.processId))
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
      pauseReading: () => {
        server.readingPaused = true
      },
      resumeReading: () => {
        server.readingPaused = false
        for (const resume of held.splice(0)) {
          resume()
        }
      },
      notify: () => {},
      respond: () => {},
      respondWithError: () => {},
      close: async () => {
        closed = true
        closeResult = { root: 'exited', tree: closeTree }
        handlers.onExit?.(new Error('closed'), { expected: true })
        return true
      }
    }
  }
  // The host sweep finds nothing left of a chat unless a test leaves something running.
  const sweep = { leftovers: false }
  return {
    servers,
    sweep,
    pool: new CodexSharedServerPool(connect, async () => !sweep.leftovers)
  }
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
    const teardown = servers[0]!.requests.filter((r) =>
      ['turn/interrupt', 'thread/unsubscribe'].includes(r.method)
    )
    expect(teardown).toEqual([
      { method: 'turn/interrupt', params: { threadId: 'thread-1', turnId: 'turn-1' } },
      { method: 'thread/unsubscribe', params: { threadId: 'thread-1' } }
    ])
    expect(a.exits).toEqual([{ message: 'codex app-server connection closed', expected: true }])
    expect(connB.closed).toBe(false)
  })

  it('keeps routing a closing chat until its turns are proven over, interrupting a helper it announces meanwhile', async () => {
    vi.useFakeTimers()
    const { servers, pool } = fakeCodex('later')
    const a = chat()
    const connA = await pool.open(launch(), a.handlers, { sessionId: 'a', skillRoots: [] })
    await pool.open(launch(), chat().handlers, { sessionId: 'b', skillRoots: [] })
    const threadA = await startThread(connA)
    const { handlers } = servers[0]!
    handlers.onNotification?.('turn/started', { threadId: threadA, turn: { id: 't' } })
    const closing = connA.close()
    await vi.advanceTimersByTimeAsync(0)
    handlers.onNotification?.('item/started', {
      threadId: threadA,
      item: { type: 'subAgentActivity', id: 'i1', kind: 'started', agentThreadId: 'helper-1' }
    })
    handlers.onNotification?.('turn/started', { threadId: 'helper-1', turn: { id: 'h' } })
    await vi.advanceTimersByTimeAsync(20_000)
    await expect(closing).resolves.toBe(true)
    expect(a.notifications).toContainEqual({
      method: 'turn/started',
      params: { threadId: 'helper-1', turn: { id: 'h' } }
    })
    expect(servers[0]!.requests).toContainEqual({
      method: 'turn/interrupt',
      params: { threadId: 'helper-1', turnId: 'h' }
    })
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

  async function backloggedPair() {
    const { servers, pool } = fakeCodex()
    const a = chat()
    const b = chat()
    const connA = await pool.open(launch(), a.handlers, { sessionId: 'a', skillRoots: [] })
    const connB = await pool.open(launch(), b.handlers, { sessionId: 'b', skillRoots: [] })
    const threadA = await startThread(connA)
    const threadB = await startThread(connB)
    const megabyte = (threadId: string): void =>
      servers[0]!.handlers.onNotification?.('item/agentMessage/delta', {
        threadId,
        delta: 'x'.repeat(1024 * 1024)
      })
    return { server: servers[0]!, a, b, connA, connB, threadA, threadB, megabyte }
  }

  it('makes the server wait while every chat is paused, dropping no one', async () => {
    vi.useFakeTimers()
    const { server, a, b, connA, connB, threadA, threadB, megabyte } = await backloggedPair()
    connA.pauseReading?.()
    connB.pauseReading?.()
    for (let i = 0; i < 20; i += 1) {
      megabyte(threadA)
      megabyte(threadB)
    }
    // 40 MiB queued across the two chats: past the 32 MiB server budget, Codex now waits.
    expect(server.readingPaused).toBe(true)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(a.exits).toEqual([])
    connB.resumeReading?.()
    // Replayed a 64 KiB chunk per task, as a pipe read would, not 20 MiB at once.
    expect(b.notifications.filter((n) => n.method === 'item/agentMessage/delta')).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(100)
    expect(b.notifications.filter((n) => n.method === 'item/agentMessage/delta')).toHaveLength(20)
    // A alone still holds 20 MiB, above the 16 MiB the server resumes at; B now asks for something.
    expect(server.readingPaused).toBe(true)
    void connB.request('thread/read', { threadId: threadB })
    // A gets a grace to catch up before it is dropped.
    await vi.advanceTimersByTimeAsync(1_000)
    expect(a.exits).toEqual([])
    await vi.advanceTimersByTimeAsync(1_000)
    expect(a.exits).toHaveLength(1)
    expect(server.readingPaused).toBe(false)
    expect(connB.closed).toBe(false)
  })

  it('drops a lagging chat after a short grace when another chat on its server runs a turn', async () => {
    vi.useFakeTimers()
    const { server, a, b, connA, threadA, threadB, megabyte } = await backloggedPair()
    server.handlers.onNotification?.('turn/started', { threadId: threadB, turn: { id: 'tb' } })
    connA.pauseReading?.()
    for (let i = 0; i < 40; i += 1) {
      megabyte(threadA)
    }
    expect(server.readingPaused).toBe(true)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(a.exits).toHaveLength(1)
    expect(server.readingPaused).toBe(false)
    server.handlers.onNotification?.('item/agentMessage/delta', { threadId: threadB })
    expect(b.notifications.at(-1)?.method).toBe('item/agentMessage/delta')
  })

  it('gives a chat that keeps catching up more time, even while another chat waits', async () => {
    vi.useFakeTimers()
    const { server, a, b, connA, threadA, threadB, megabyte } = await backloggedPair()
    server.handlers.onNotification?.('turn/started', { threadId: threadB, turn: { id: 'tb' } })
    let draining = false
    const handlers = a.handlers.onNotification
    a.handlers.onNotification = (method, params) => {
      handlers?.(method, params)
      // Its journal takes one frame, then pushes back again.
      if (draining) {
        connA.pauseReading?.()
      }
    }
    connA.pauseReading?.()
    // Just past the budget: the paused reader takes nothing more.
    for (let i = 0; i < 33; i += 1) {
      megabyte(threadA)
    }
    expect(server.readingPaused).toBe(true)
    draining = true
    // About 1 MiB a second: slow, but always moving.
    for (let i = 0; i < 30 && server.readingPaused; i += 1) {
      connA.resumeReading?.()
      await vi.advanceTimersByTimeAsync(1_000)
    }
    expect(a.exits).toEqual([])
    expect(b.exits).toEqual([])
    expect(server.readingPaused).toBe(false)
  })

  it("does not let a paused chat's backlog hold up another chat's close", async () => {
    vi.useFakeTimers()
    const { server, a, connA, connB, threadA, threadB, megabyte } = await backloggedPair()
    connA.pauseReading?.()
    connB.pauseReading?.()
    for (let i = 0; i < 40; i += 1) {
      megabyte(threadA)
    }
    void threadB
    expect(server.readingPaused).toBe(true)
    const closing = connB.close()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(a.exits).toHaveLength(1)
    expect(server.readingPaused).toBe(false)
    await expect(closing).resolves.toBe(true)
  })

  it('retries a dropped chat whose turn ignores Stop only when that turn ends, never on a clock', async () => {
    vi.useFakeTimers()
    const { servers, pool } = fakeCodex('ignored')
    const a = chat()
    const connA = await pool.open(launch(), a.handlers, { sessionId: 'a', skillRoots: [] })
    const connB = await pool.open(launch(), chat().handlers, { sessionId: 'b', skillRoots: [] })
    const threadA = await startThread(connA)
    servers[0]!.handlers.onNotification?.('turn/started', { threadId: threadA, turn: { id: 't' } })
    connA.pauseReading?.()
    for (let i = 0; i <= CODEX_SHARED_LEASE_MAX_QUEUED_FRAMES; i += 1) {
      servers[0]!.handlers.onNotification?.('item/agentMessage/delta', { threadId: threadA })
    }
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000)
    const interrupts = servers[0]!.requests.filter((r) => r.method === 'turn/interrupt')
    expect(interrupts).toHaveLength(1)
    expect(a.exits).toEqual([])
    servers[0]!.handlers.onNotification?.('turn/completed', {
      threadId: threadA,
      turn: { id: 't', status: 'interrupted' }
    })
    await vi.waitFor(() => expect(a.exits).toHaveLength(1))
    expect(connB.closed).toBe(false)
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

  it('keeps a chat whose turn ignores Stop on the server until a retry finds it alone, then stops that server', async () => {
    vi.useFakeTimers()
    const { servers, pool } = fakeCodex('ignored')
    const connA = await pool.open(launch(), chat().handlers, { sessionId: 'a', skillRoots: [] })
    const idle = await pool.open(launch(), chat().handlers, { sessionId: 'b', skillRoots: [] })
    const threadA = await startThread(connA)
    servers[0]!.handlers.onNotification?.('turn/started', { threadId: threadA, turn: { id: 't' } })
    const firstClose = connA.close()
    await vi.advanceTimersByTimeAsync(20_000)
    await expect(firstClose).resolves.toBe(false)
    expect(idle.closed).toBe(false)
    await idle.close()
    const retry = connA.close()
    await vi.advanceTimersByTimeAsync(20_000)
    await expect(retry).resolves.toBe(true)
    expect(connA.processTreeUnproven).toBe(false)
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
    await expect(closingX).resolves.toBe(false)
    expect(y.closed).toBe(false)
  })

  it('makes a recovering chat resume its thread only after the old lease has let go of it', async () => {
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
    // The replacement's resume waits until the old chat's cleanup is done with the thread.
    const resumed = replacement.request('thread/resume', { threadId: threadA })
    await vi.advanceTimersByTimeAsync(5_000)
    await resumed
    expect(a.exits).toHaveLength(1)
    // The old chat let go of the thread before the replacement subscribed to it again.
    const order = servers[0]!.requests
      .filter((r) => r.params?.threadId === threadA)
      .map((r) => r.method)
      .filter((method) => method === 'thread/unsubscribe' || method === 'thread/resume')
    expect(order).toEqual(['thread/unsubscribe', 'thread/resume'])
  })

  it('refuses a second chat resuming a thread another chat on the server has open', async () => {
    const { servers, pool } = fakeCodex()
    const a = chat()
    const connA = await pool.open(launch(), a.handlers, { sessionId: 'a', skillRoots: [] })
    const connB = await pool.open(launch(), chat().handlers, { sessionId: 'b', skillRoots: [] })
    const threadA = await startThread(connA)
    await expect(connB.request('thread/resume', { threadId: threadA })).rejects.toMatchObject({
      method: 'thread/resume',
      code: -32600,
      message: expect.stringContaining(`thread ${threadA} already has an active writer`)
    })
    servers[0]!.handlers.onNotification?.('item/agentMessage/delta', { threadId: threadA })
    expect(a.notifications.map((n) => n.method)).toContain('item/agentMessage/delta')
  })

  it('lets another chat open a thread this chat failed to resume', async () => {
    const { pool } = fakeCodex()
    const connA = await pool.open(launch(), chat().handlers, { sessionId: 'a', skillRoots: [] })
    const connB = await pool.open(launch(), chat().handlers, { sessionId: 'b', skillRoots: [] })
    await expect(
      connA.request('thread/resume', { threadId: 'thread-gone', gone: true })
    ).rejects.toThrow('no rollout found')
    await expect(connB.request('thread/resume', { threadId: 'thread-gone' })).resolves.toEqual({
      thread: { id: 'thread-gone' }
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

    const unproven = fakeCodex('ends', 'unverifiable')
    const connB = await unproven.pool.open(launch(), chat().handlers, {
      sessionId: 'b',
      skillRoots: []
    })
    const sibling = await unproven.pool.open(launch(), chat().handlers, {
      sessionId: 'c',
      skillRoots: []
    })
    unproven.servers[0]!.closeTransport()
    await connB.close()
    // The server's root exit is no proof its commands are gone, for this chat or its neighbour.
    expect(connB.processTreeUnproven).toBe(true)
    await sibling.close()
    expect(sibling.processTreeUnproven).toBe(true)
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
    await expect(closing).resolves.toBe(false)
    expect(connB.closed).toBe(false)
  })

  it('never shares a server for a custom Codex command, or on Windows', () => {
    const opener = codexConnectionOpener({ sharedServers: () => true }, 's', {
      customCommand: true
    })
    expect(opener).toBe(spawnCodexAppServerConnection)
    expect(codexConnectionOpener({ sharedServers: () => true }, 's', {}, 'win32')).toBe(
      spawnCodexAppServerConnection
    )
  })

  it("marks a shared opener, so a chat's recovery never signals the server it shares", () => {
    expect(
      opensSharedCodexServer(codexConnectionOpener({ sharedServers: () => true }, 's', {}, 'linux'))
    ).toBe(true)
    expect(
      opensSharedCodexServer(
        codexConnectionOpener({ sharedServers: () => false }, 's', {}, 'linux')
      )
    ).toBe(false)
  })

  it('does not count a server exit during Stop as the turn ending', async () => {
    vi.useFakeTimers()
    const { servers, pool } = fakeCodex('ignored', 'unverifiable')
    const connA = await pool.open(launch(), chat().handlers, { sessionId: 'a', skillRoots: [] })
    const threadA = await startThread(connA)
    servers[0]!.handlers.onNotification?.('turn/started', { threadId: threadA, turn: { id: 't' } })
    const closing = connA.close()
    await vi.advanceTimersByTimeAsync(1_000)
    servers[0]!.crash()
    await vi.advanceTimersByTimeAsync(20_000)
    await closing
    expect(connA.processTreeUnproven).toBe(true)
  })

  it("routes a helper a parent's item announced, with no thread/started of its own, to the parent's chat", async () => {
    const { servers, pool } = fakeCodex()
    const requests: string[] = []
    const a = chat()
    const connA = await pool.open(
      launch(),
      { ...a.handlers, onServerRequest: (request) => requests.push(request.method) },
      { sessionId: 'a', skillRoots: [] }
    )
    const threadA = await startThread(connA)
    const { handlers } = servers[0]!
    handlers.onNotification?.('item/started', {
      threadId: threadA,
      item: {
        type: 'subAgentActivity',
        id: 'i1',
        kind: 'started',
        agentThreadId: 'helper-1',
        agentPath: 'root/helper'
      }
    })
    handlers.onNotification?.('turn/started', { threadId: 'helper-1', turn: { id: 'h' } })
    handlers.onServerRequest?.({
      id: 7,
      method: 'item/commandExecution/requestApproval',
      params: { threadId: 'helper-1' }
    })
    expect(a.notifications.at(-1)).toEqual({
      method: 'turn/started',
      params: { threadId: 'helper-1', turn: { id: 'h' } }
    })
    expect(requests).toEqual(['item/commandExecution/requestApproval'])
  })

  it("stops the chat's own background commands on close, and reports Stop unproven when one survives", async () => {
    const { servers, pool } = fakeCodex()
    const connA = await pool.open(launch(), chat().handlers, { sessionId: 'a', skillRoots: [] })
    const threadA = await startThread(connA)
    servers[0]!.terminals.set(threadA, new Set(['p1']))
    await connA.close()
    expect(servers[0]!.terminals.get(threadA)?.size).toBe(0)
    expect(connA.processTreeUnproven).toBe(false)

    const stuck = fakeCodex('ends', 'exited', false)
    const connB = await stuck.pool.open(launch(), chat().handlers, {
      sessionId: 'b',
      skillRoots: []
    })
    const sibling = await stuck.pool.open(launch(), chat().handlers, {
      sessionId: 'c',
      skillRoots: []
    })
    const threadB = await startThread(connB)
    stuck.servers[0]!.terminals.set(threadB, new Set(['p2']))
    await connB.close()
    expect(connB.processTreeUnproven).toBe(true)
    expect(sibling.closed).toBe(false)
  })

  it('stops the server for a chat alone on it whose leftover command survived its cleanup', async () => {
    const { servers, pool } = fakeCodex('ends', 'exited', false)
    const connA = await pool.open(launch(), chat().handlers, { sessionId: 'a', skillRoots: [] })
    const threadA = await startThread(connA)
    servers[0]!.terminals.set(threadA, new Set(['p1']))
    await expect(connA.close()).resolves.toBe(true)
    expect(connA.processTreeUnproven).toBe(false)
    const next = await pool.open(launch(), chat().handlers, { sessionId: 'b', skillRoots: [] })
    expect(next.pid).not.toBe(servers[0]!.pid)
  })

  it('lets go of a thread that opens after its chat closed', async () => {
    const { servers, pool } = fakeCodex()
    const connA = await pool.open(launch(), chat().handlers, { sessionId: 'a', skillRoots: [] })
    const opening = connA.request('thread/start', { cwd: '/work', holdOpen: true })
    const closing = connA.close()
    servers[0]!.releaseOpen()
    await opening
    await closing
    const opened = servers[0]!.requests.filter((r) => r.method === 'thread/unsubscribe')
    expect(opened).toEqual([{ method: 'thread/unsubscribe', params: { threadId: 'thread-1' } }])
    expect(connA.processTreeUnproven).toBe(false)
  })

  it("leaves Stop unproven when an older Codex can't list commands and one is left under the server", async () => {
    const { servers, pool, sweep } = fakeCodex('ends', 'exited', true, { listUnsupported: true })
    const connA = await pool.open(launch(), chat().handlers, { sessionId: 'a', skillRoots: [] })
    await pool.open(launch(), chat().handlers, { sessionId: 'b', skillRoots: [] })
    await startThread(connA)
    sweep.leftovers = true
    await connA.close()
    expect(servers[0]!.requests.map((r) => r.method)).toContain('thread/backgroundTerminals/clean')
    expect(connA.processTreeUnproven).toBe(true)
  })

  it('leaves Stop unproven when Codex refuses to let go of a thread that opened after close', async () => {
    const { servers, pool } = fakeCodex('ends', 'exited', true, { unsubscribeFails: true })
    const connA = await pool.open(launch(), chat().handlers, { sessionId: 'a', skillRoots: [] })
    // Another chat is working, so the server can't simply be stopped to prove it.
    const connB = await pool.open(launch(), chat().handlers, { sessionId: 'b', skillRoots: [] })
    const threadB = await startThread(connB)
    servers[0]!.handlers.onNotification?.('turn/started', { threadId: threadB, turn: { id: 'b' } })
    const opening = connA.request('thread/start', { cwd: '/work', holdOpen: true })
    const closing = connA.close()
    servers[0]!.releaseOpen()
    await opening.catch(() => {})
    await closing
    expect(connA.processTreeUnproven).toBe(true)
    expect(connB.closed).toBe(false)
  })

  it('lets go of a thread whose open answers after its caller timed out', async () => {
    vi.useFakeTimers()
    const { servers, pool } = fakeCodex()
    const connA = await pool.open(launch(), chat().handlers, { sessionId: 'a', skillRoots: [] })
    const opening = connA.request('thread/start', { holdOpen: true }, { timeoutMs: 1_000 })
    const failed = expect(opening).rejects.toThrow('exceeded 1000ms')
    await vi.advanceTimersByTimeAsync(1_500)
    await failed
    servers[0]!.releaseOpen()
    expect(servers[0]!.requests).toContainEqual({
      method: 'thread/unsubscribe',
      params: { threadId: 'thread-1' }
    })
    expect(connA.closed).toBe(false)
  })

  it('lets go of a resumed thread whose caller timed out, though the chat stays open', async () => {
    vi.useFakeTimers()
    const { servers, pool } = fakeCodex()
    const a = chat()
    const connA = await pool.open(launch(), a.handlers, { sessionId: 'a', skillRoots: [] })
    const resuming = connA.request(
      'thread/resume',
      { threadId: 'old-thread', holdOpen: true },
      { timeoutMs: 1_000 }
    )
    const failed = expect(resuming).rejects.toThrow('exceeded 1000ms')
    await vi.advanceTimersByTimeAsync(1_500)
    await failed
    servers[0]!.releaseOpen()
    expect(servers[0]!.requests).toContainEqual({
      method: 'thread/unsubscribe',
      params: { threadId: 'old-thread' }
    })
    // Its frames no longer reach the chat.
    servers[0]!.handlers.onNotification?.('turn/started', {
      threadId: 'old-thread',
      turn: { id: 'late' }
    })
    expect(a.notifications.map((n) => n.method)).not.toContain('turn/started')
  })
})
