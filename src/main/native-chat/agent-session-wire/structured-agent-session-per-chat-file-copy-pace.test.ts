// The background copy's share of the main thread: no second gives it more than the share, the
// burst and the one chat's work that crossed it, a chat's own tasks never wait, a stall counts, and
// quit ends a wait at once.

import { describe, expect, it, vi } from 'vitest'
import {
  PER_CHAT_FILE_COPY_BURST_MS,
  PER_CHAT_FILE_COPY_SHARE,
  StructuredAgentSessionPerChatFileCopyPace
} from './structured-agent-session-per-chat-file-copy-pace'

/** A pace on a clock the test moves; a wait moves the clock by what it waits. */
function pacedClock() {
  const clock = { now: 0 }
  const waits: number[] = []
  const pace = new StructuredAgentSessionPerChatFileCopyPace(
    () => clock.now,
    async (ms) => {
      waits.push(ms)
      clock.now += ms
    }
  )
  /** Runs tasks of these costs, a yield after each; answers when each ran. */
  const run = async (costs: number[]) => {
    const tasks: { start: number; end: number }[] = []
    pace.begin()
    for (const cost of costs) {
      tasks.push({ start: clock.now, end: clock.now + cost })
      clock.now += cost
      await pace.yieldTask()
    }
    return tasks
  }
  return { clock, waits, pace, run }
}

/** The most busy time any one-second window holds. */
function busiestSecond(tasks: { start: number; end: number }[]): number {
  let most = 0
  for (const from of tasks.map((task) => task.start)) {
    const to = from + 1_000
    const busy = tasks.reduce(
      (sum, t) => sum + Math.max(0, Math.min(t.end, to) - Math.max(t.start, from)),
      0
    )
    most = Math.max(most, busy)
  }
  return most
}

describe('the copy’s share of each second (C3)', () => {
  it('holds any second to its share, its burst and the one chat that crossed it', async () => {
    const { clock, waits, run } = pacedClock()
    // Idle a long while first: what it saves is capped at the burst.
    clock.now = 10_000

    const tasks = await run(Array.from({ length: 60 }, () => 40))

    expect(waits.length).toBeGreaterThan(0)
    expect(busiestSecond(tasks)).toBeLessThanOrEqual(
      PER_CHAT_FILE_COPY_BURST_MS + PER_CHAT_FILE_COPY_SHARE * 1_000 + 40
    )
  })

  it('counts a task that stalls, and waits until the share catches up', async () => {
    const { waits, run } = pacedClock()

    await run([200])

    const debt = 200 - PER_CHAT_FILE_COPY_BURST_MS - 200 * PER_CHAT_FILE_COPY_SHARE
    expect(waits).toEqual([debt / PER_CHAT_FILE_COPY_SHARE])
  })

  it('takes no wait inside its burst', async () => {
    const { waits, run } = pacedClock()

    await run([10, 10, 10])

    expect(waits).toEqual([])
  })

  it('ends a wait at quit, and waits no more after it', async () => {
    const clock = { now: 0 }
    const pace = new StructuredAgentSessionPerChatFileCopyPace(() => clock.now)
    pace.begin()
    clock.now = 500
    const waiting = pace.yieldTask()
    const settled = vi.fn()
    void waiting.then(settled)
    await new Promise((resolve) => setImmediate(resolve))
    expect(settled).not.toHaveBeenCalled()

    pace.stop()
    const raced = await Promise.race([
      waiting.then(() => 'ended'),
      new Promise((resolve) => setTimeout(() => resolve('still waiting'), 200))
    ])
    expect(raced).toBe('ended')
    clock.now = 1_000
    await expect(pace.yieldTask()).resolves.toBeUndefined()
  })

  it('never waits inside a chat, and pays that chat’s debt at the next yield between chats', async () => {
    const { clock, waits, pace } = pacedClock()
    pace.begin()

    await pace.inChat(
      (_sessionId, task) => task(),
      'session-held',
      async (yieldTask) => {
        for (let part = 0; part < 4; part += 1) {
          clock.now += 50
          await yieldTask()
        }
      }
    )
    expect(waits).toEqual([])
    await pace.yieldTask()

    // 200 ms of work against a 50 ms burst: a debt of 120 ms, paid as 800 ms of wait.
    const debt = 200 - PER_CHAT_FILE_COPY_BURST_MS - 200 * PER_CHAT_FILE_COPY_SHARE
    expect(waits).toEqual([debt / PER_CHAT_FILE_COPY_SHARE])
  })

  it('charges nothing while it waits for a chat’s lock', async () => {
    const { clock, waits, pace } = pacedClock()
    pace.begin()

    await pace.inChat(
      async (_sessionId, task) => {
        // Someone else holds the chat for two seconds.
        clock.now += 2_000
        return task()
      },
      'session-held',
      async () => undefined
    )
    await pace.yieldTask()

    expect(waits).toEqual([])
  })
})
