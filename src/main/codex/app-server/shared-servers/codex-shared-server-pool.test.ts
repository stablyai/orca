import { afterEach, describe, expect, it, vi } from 'vitest'
import { CODEX_SHARED_LEASE_MAX_QUEUED_FRAMES } from './codex-shared-server-lease'
import {
  codexConnectionOpener,
  opensSharedCodexServer
} from '../../structured/acquisition/codex-structured-connection-opener'
import { spawnCodexAppServerConnection } from '../codex-app-server-connection'
import { chat, fakeCodex, launch, startThread } from './codex-shared-server-pool-fixture'
import { field } from './codex-shared-server-frames'
import { CODEX_SHARED_SERVER_HUNG_MS } from './codex-shared-server-hang-watch'

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

  it("gives a thread's unreadable or unknown frames only to its chat, and other chats none", async () => {
    const { servers, pool } = fakeCodex()
    const a = chat()
    const b = chat()
    const unreadA: string[] = []
    const unreadB: string[] = []
    const connA = await pool.open(
      launch(),
      { ...a.handlers, onUnhandledFrame: (kind) => unreadA.push(kind) },
      { sessionId: 'a', skillRoots: [] }
    )
    await pool.open(
      launch(),
      { ...b.handlers, onUnhandledFrame: (kind) => unreadB.push(kind) },
      { sessionId: 'b', skillRoots: [] }
    )
    const threadA = await startThread(connA)
    const { handlers } = servers[0]!
    handlers.onUnhandledFrame?.('frame:unclassified', { id: 'x', params: { threadId: threadA } })
    handlers.onUnhandledFrame?.('frame:invalid-json', '{"text":"words from chat A')
    handlers.onNotification?.('item/newKind/delta', { thread_id: threadA, text: 'mine' })
    handlers.onNotification?.('item/otherKind/delta', { text: 'private' })

    expect(unreadA).toEqual(['frame:unclassified'])
    expect(unreadB).toEqual([])
    expect(a.notifications.map((n) => n.method)).toContain('item/newKind/delta')
    expect(b.notifications.map((n) => n.method)).not.toContain('item/newKind/delta')
    expect(b.notifications.map((n) => n.method)).not.toContain('item/otherKind/delta')
  })

  it('gives an account request to a chat that is reading, not one that is paused', async () => {
    const { servers, pool } = fakeCodex()
    const askedA: string[] = []
    const askedB: string[] = []
    const connA = await pool.open(
      launch(),
      { ...chat().handlers, onServerRequest: (request) => askedA.push(request.method) },
      { sessionId: 'a', skillRoots: [] }
    )
    await pool.open(
      launch(),
      { ...chat().handlers, onServerRequest: (request) => askedB.push(request.method) },
      { sessionId: 'b', skillRoots: [] }
    )
    connA.pauseReading?.()
    servers[0]!.handlers.onServerRequest?.({
      id: 7,
      method: 'account/chatgptAuthTokens/refresh',
      params: {}
    })
    expect(askedA).toEqual([])
    expect(askedB).toEqual(['account/chatgptAuthTokens/refresh'])
  })

  it("gives each chat's threads that chat's own Orca identity, not the server's", async () => {
    const { servers, pool } = fakeCodex()
    const launchA = launch()
    const launchB = launch()
    const connA = await pool.open(launchA, chat().handlers, { sessionId: 'a', skillRoots: [] })
    const connB = await pool.open(launchB, chat().handlers, { sessionId: 'b', skillRoots: [] })
    await startThread(connA)
    await startThread(connB)
    const sessionIds = servers[0]!.requests
      .filter((r) => r.method === 'thread/start')
      .map((r) => field(r.params, 'config', 'shell_environment_policy.set.ORCA_AGENT_SESSION_ID'))
    expect(sessionIds).toEqual([
      launchA.env.ORCA_AGENT_SESSION_ID,
      launchB.env.ORCA_AGENT_SESSION_ID
    ])
  })

  it('serves every chat with one launch on one server and never shares across account homes', async () => {
    const { servers, pool } = fakeCodex()
    const conns = await Promise.all(
      Array.from({ length: 41 }, (_, i) =>
        pool.open(launch(), chat().handlers, { sessionId: `c${i}`, skillRoots: [] })
      )
    )
    const threads = await Promise.all(conns.map((conn) => startThread(conn)))
    expect(servers).toHaveLength(1)
    expect(new Set(threads).size).toBe(41)
    await pool.open(launch('/home/b/.codex'), chat().handlers, {
      sessionId: 'other-account',
      skillRoots: []
    })
    expect(servers).toHaveLength(2)
  })

  it('retires a server that answers nothing for the hang window, and the next chat gets a new one', async () => {
    const { servers, pool } = fakeCodex()
    const a = chat()
    const b = chat()
    const connA = await pool.open(launch(), a.handlers, { sessionId: 'a', skillRoots: [] })
    await pool.open(launch(), b.handlers, { sessionId: 'b', skillRoots: [] })
    const threadA = await startThread(connA)
    vi.useFakeTimers()
    // A busy server that keeps talking is slow, not hung.
    void connA.request('turn/start', { threadId: threadA, hang: true }).catch(() => {})
    await vi.advanceTimersByTimeAsync(CODEX_SHARED_SERVER_HUNG_MS - 1)
    servers[0]!.handlers.onNotification?.('item/agentMessage/delta', { threadId: threadA })
    await vi.advanceTimersByTimeAsync(CODEX_SHARED_SERVER_HUNG_MS)
    expect(a.exits).toEqual([])
    // A silent one is retired, even after the transport timed the request out: every chat on it
    // ends as an unexpected exit.
    void connA.request('turn/start', { threadId: threadA, timesOut: true }).catch(() => {})
    await vi.advanceTimersByTimeAsync(CODEX_SHARED_SERVER_HUNG_MS)
    expect(a.exits.map((exit) => exit.expected)).toEqual([false])
    expect(b.exits.map((exit) => exit.expected)).toEqual([false])
    await pool.open(launch(), chat().handlers, { sessionId: 'a', skillRoots: [] })
    expect(servers).toHaveLength(2)
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

  it('never proves a Stop while a timed-out turn/start may still run, until that turn is seen', async () => {
    vi.useFakeTimers()
    const { servers, pool } = fakeCodex()
    const connA = await pool.open(launch(), chat().handlers, { sessionId: 'a', skillRoots: [] })
    await pool.open(launch(), chat().handlers, { sessionId: 'b', skillRoots: [] })
    const threadA = await startThread(connA)
    await expect(
      connA.request('turn/start', { threadId: threadA, timesOut: true })
    ).rejects.toThrow()
    const firstClose = connA.close()
    await vi.advanceTimersByTimeAsync(20_000)
    await expect(firstClose).resolves.toBe(false)
    // Codex runs the late start after all; Stop interrupts it and then proves.
    servers[0]!.handlers.onNotification?.('turn/started', {
      threadId: threadA,
      turn: { id: 'late' }
    })
    const retry = connA.close()
    await vi.advanceTimersByTimeAsync(20_000)
    await expect(retry).resolves.toBe(true)
    expect(servers[0]!.requests.some((r) => r.method === 'turn/interrupt')).toBe(true)
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

  it("keeps a new thread's early frames while its start reply is slow", async () => {
    vi.useFakeTimers()
    const { servers, pool } = fakeCodex()
    const a = chat()
    const connA = await pool.open(launch(), a.handlers, { sessionId: 'a', skillRoots: [] })
    const started = connA.request(
      'thread/start',
      { cwd: '/work', holdOpen: true },
      { timeoutMs: null }
    )
    servers[0]!.handlers.onNotification?.('thread/started', { thread: { id: 'thread-1' } })
    await vi.advanceTimersByTimeAsync(60_000)
    servers[0]!.releaseOpen()
    await started
    expect(a.notifications.map((n) => n.method)).toContain('thread/started')
  })

  it('ends a chat whose new thread lost its early frames to the hold cap, so it reopens it whole', async () => {
    const { servers, pool } = fakeCodex()
    const a = chat()
    const connA = await pool.open(launch(), a.handlers, { sessionId: 'a', skillRoots: [] })
    const started = connA.request(
      'thread/start',
      { cwd: '/work', holdOpen: true },
      { timeoutMs: null }
    )
    servers[0]!.handlers.onNotification?.('thread/started', { thread: { id: 'thread-1' } })
    // Other unclaimed threads push the held frames past the cap, and enough of them that the
    // record of which threads lost frames overflows too.
    for (let i = 0; i < 8_000; i += 1) {
      servers[0]!.handlers.onNotification?.('item/started', { threadId: `stray-${i}` })
    }
    servers[0]!.releaseOpen()
    await expect(started).rejects.toThrow('closed')
    await vi.waitFor(() => expect(a.exits).toHaveLength(1))
    expect(a.exits[0]?.expected).toBe(false)
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

  it('refuses a server request with no thread rather than hand it to some chat, except account requests', async () => {
    const { servers, pool } = fakeCodex()
    const requests: string[] = []
    const a = chat()
    await pool.open(
      launch(),
      { ...a.handlers, onServerRequest: (request) => requests.push(request.method) },
      { sessionId: 'a', skillRoots: [] }
    )
    await pool.open(launch(), chat().handlers, { sessionId: 'b', skillRoots: [] })
    const { handlers } = servers[0]!
    handlers.onServerRequest?.({
      id: 8,
      method: 'item/fileChange/requestApproval',
      params: { itemId: 'i1' }
    })
    handlers.onServerRequest?.({ id: 9, method: 'account/chatgptAuthTokens/refresh', params: {} })
    expect(servers[0]!.refused).toEqual([8])
    expect(requests).toEqual(['account/chatgptAuthTokens/refresh'])
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
    await expect(opening).rejects.toThrow('closed')
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

  it('does not interrupt the turn of a chat that reopened a thread another chat let go of', async () => {
    vi.useFakeTimers()
    const { servers, pool } = fakeCodex()
    const connA = await pool.open(launch(), chat().handlers, { sessionId: 'a', skillRoots: [] })
    const connB = await pool.open(launch(), chat().handlers, { sessionId: 'b', skillRoots: [] })
    const resuming = connA.request(
      'thread/resume',
      { threadId: 'shared-thread', holdOpen: true },
      { timeoutMs: 1_000 }
    )
    const failed = expect(resuming).rejects.toThrow('exceeded 1000ms')
    await vi.advanceTimersByTimeAsync(1_500)
    await failed
    servers[0]!.releaseOpen()
    await connB.request('thread/resume', { threadId: 'shared-thread' })
    servers[0]!.handlers.onNotification?.('turn/started', {
      threadId: 'shared-thread',
      turn: { id: 'b-turn' }
    })
    await connA.close()
    expect(servers[0]!.requests.filter((r) => r.method === 'turn/interrupt')).toEqual([])
  })

  it('refuses an approval for a chat that is leaving instead of leaving Codex waiting', async () => {
    vi.useFakeTimers()
    const { servers, pool } = fakeCodex('ignored')
    const requests: string[] = []
    const a = chat()
    const connA = await pool.open(
      launch(),
      { ...a.handlers, onServerRequest: (request) => requests.push(request.method) },
      { sessionId: 'a', skillRoots: [] }
    )
    await pool.open(launch(), chat().handlers, { sessionId: 'b', skillRoots: [] })
    const threadA = await startThread(connA)
    servers[0]!.handlers.onNotification?.('turn/started', { threadId: threadA, turn: { id: 't' } })
    void connA.close()
    servers[0]!.handlers.onServerRequest?.({
      id: 11,
      method: 'item/commandExecution/requestApproval',
      params: { threadId: threadA }
    })
    expect(servers[0]!.refused).toEqual([11])
    expect(requests).toEqual([])
  })
})
