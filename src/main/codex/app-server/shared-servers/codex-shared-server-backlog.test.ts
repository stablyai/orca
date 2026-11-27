import { afterEach, describe, expect, it, vi } from 'vitest'
import { chat, fakeCodex, launch, startThread } from './codex-shared-server-pool-fixture'

afterEach(() => {
  vi.useRealTimers()
})

describe('shared Codex server backlog', () => {
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

  it('makes the server wait as soon as every chat is paused and a frame is held', async () => {
    const { server, connA, connB, threadA, megabyte } = await backloggedPair()
    connA.pauseReading?.()
    connB.pauseReading?.()
    megabyte(threadA)
    expect(server.readingPaused).toBe(true)
    connB.resumeReading?.()
    expect(server.readingPaused).toBe(false)
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
    // About 5 MiB a second: slower than its frames arrive, but always moving.
    for (let i = 0; i < 30 && server.readingPaused; i += 1) {
      connA.resumeReading?.()
      await vi.advanceTimersByTimeAsync(200)
    }
    expect(a.exits).toEqual([])
    expect(b.exits).toEqual([])
    expect(server.readingPaused).toBe(false)
  })

  it('holds a waiting chat at most a few seconds behind a chat that catches up very slowly', async () => {
    vi.useFakeTimers()
    const { server, a, connA, threadA, threadB, megabyte } = await backloggedPair()
    server.handlers.onNotification?.('turn/started', { threadId: threadB, turn: { id: 'tb' } })
    const handlers = a.handlers.onNotification
    a.handlers.onNotification = (method, params) => {
      handlers?.(method, params)
      connA.pauseReading?.()
    }
    connA.pauseReading?.()
    for (let i = 0; i < 33; i += 1) {
      megabyte(threadA)
    }
    // 1 MiB a second, progress in every grace, would hold the server for 17 s.
    for (let i = 0; i < 10 && a.exits.length === 0; i += 1) {
      connA.resumeReading?.()
      await vi.advanceTimersByTimeAsync(1_000)
    }
    expect(a.exits).toHaveLength(1)
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
})
