import { describe, expect, it, vi } from 'vitest'
import type { ExternalConversationLink } from '../../shared/connectors/external-conversation-link'
import type { OrchestrationSessionWorkerState } from '../../shared/orchestration-session-workers'
import type { ConversationEvent } from './external-conversation-events'
import type { LinkedConversation } from './external-conversation-links'
import {
  CONVERSATION_WORKERS_MAX_RUNNING_MS,
  CONVERSATION_WORKERS_MAX_UNVERIFIABLE_MS,
  CONVERSATION_WORKERS_POLL_MS,
  ConversationWorkers,
  conversationWorkerActivity,
  type ConversationWorkerActivity
} from './external-conversation-workers'

const PANE = 'chat:s1'
const LINK: ExternalConversationLink = {
  source: 'slack',
  externalId: 'T1:C1:1',
  paneKey: PANE,
  sessionId: 's1',
  agent: 'claude',
  createdAt: 0,
  bot: { kind: 'bot', botId: 'b1' }
}

function tracker(initial: ConversationWorkerActivity | null) {
  let activity: ConversationWorkerActivity | null | Error = initial
  let now = 1_000
  let linked = true
  const timers: { run: () => void; at: number }[] = []
  const told: boolean[] = []
  const workers = new ConversationWorkers({
    workerActivity: async () => {
      if (activity instanceof Error) {
        throw activity
      }
      return activity
    },
    linkedFor: (paneKey): LinkedConversation | null =>
      paneKey === PANE && linked
        ? { workspace: { worktreeId: 'wt', sshHostId: null }, link: LINK }
        : null,
    emit: (event: ConversationEvent) => {
      if (event.kind === 'workers') {
        told.push(event.running)
      }
    },
    setTimer: (run, delayMs) => {
      const timer = { run, at: now + delayMs }
      timers.push(timer)
      return { cancel: () => timers.splice(timers.indexOf(timer), 1) }
    },
    now: () => now
  })
  return {
    workers,
    told,
    timers,
    set: (next: ConversationWorkerActivity | null | Error) => {
      activity = next
    },
    unlink: () => {
      linked = false
    },
    /** Moves the clock and runs the poll if it is due. */
    advance: async (ms: number) => {
      now += ms
      for (const timer of timers.filter((entry) => entry.at <= now)) {
        timers.splice(timers.indexOf(timer), 1)
        timer.run()
      }
      // Let the polled reads settle.
      await new Promise((resolve) => setImmediate(resolve))
    }
  }
}

describe('a chat conversation’s workers', () => {
  it('stay running past the turn that started them, and end with the last worker', async () => {
    const t = tracker('working')
    await t.workers.check(PANE, 'turn-ended')
    expect(t.told).toEqual([true])
    expect(t.workers.runningOf(PANE)).toBe(true)

    await t.advance(CONVERSATION_WORKERS_POLL_MS)
    expect(t.told).toEqual([true])

    t.set('none')
    await t.advance(CONVERSATION_WORKERS_POLL_MS)
    expect(t.told).toEqual([true, false])
    // Nothing runs, so nothing is polled until the next turn end.
    expect(t.timers).toEqual([])
  })

  it('tell nothing at a turn end when none ran', async () => {
    const t = tracker('none')
    await t.workers.check(PANE, 'turn-ended')
    expect(t.told).toEqual([])
    expect(t.workers.runningOf(PANE)).toBe(false)
  })

  it('tell a watch’s first read either way, since a process before this one may have said running', async () => {
    const stopped = tracker('none')
    await stopped.workers.check(PANE, 'watch')
    expect(stopped.told).toEqual([false])

    const running = tracker('working')
    await running.workers.check(PANE, 'watch')
    expect(running.told).toEqual([true])
  })

  it('keep a worker out of contact running for a while, never forever', async () => {
    const t = tracker('working')
    await t.workers.check(PANE, 'turn-ended')
    t.set('unverifiable')
    await t.advance(CONVERSATION_WORKERS_POLL_MS)
    expect(t.told).toEqual([true])

    await t.advance(CONVERSATION_WORKERS_MAX_UNVERIFIABLE_MS)
    expect(t.told).toEqual([true, false])
  })

  it('stop holding a worker that never settles, until the bot’s next turn ends', async () => {
    const t = tracker('working')
    await t.workers.check(PANE, 'turn-ended')
    await t.advance(CONVERSATION_WORKERS_MAX_RUNNING_MS)
    expect(t.told).toEqual([true, false])
    expect(t.timers).toEqual([])

    await t.workers.check(PANE, 'turn-ended')
    expect(t.told).toEqual([true, false, true])
  })

  it('keep running through failed reads, but only as long as lost contact may', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const t = tracker('working')
    await t.workers.check(PANE, 'turn-ended')
    t.set(new Error('db closed'))
    await t.advance(CONVERSATION_WORKERS_POLL_MS)
    expect(t.told).toEqual([true])
    await t.advance(CONVERSATION_WORKERS_MAX_UNVERIFIABLE_MS)
    expect(t.told).toEqual([true, false])

    // With nothing running before, a failed read stays none.
    const idle = tracker('none')
    await idle.workers.check(PANE, 'turn-ended')
    idle.set(new Error('db closed'))
    await idle.workers.check(PANE, 'turn-ended')
    expect(idle.told).toEqual([])
    warn.mockRestore()
  })

  it('tell nothing where the host reads no workers', async () => {
    const t = tracker(null)
    await t.workers.check(PANE, 'watch')
    await t.workers.check(PANE, 'turn-ended')
    expect(t.told).toEqual([])
    expect(t.workers.runningOf(PANE)).toBeUndefined()
  })

  it('forget a conversation that is no longer linked, telling it stopped if it ran', async () => {
    const t = tracker('working')
    await t.workers.check('chat:gone', 'turn-ended')
    expect(t.told).toEqual([])
    expect(t.workers.isKnown('chat:gone')).toBe(false)

    await t.workers.check(PANE, 'turn-ended')
    t.unlink()
    await t.advance(CONVERSATION_WORKERS_POLL_MS)
    expect(t.told).toEqual([true, false])
    expect(t.timers).toEqual([])
  })

  it('apply only the newest read', async () => {
    const t = tracker('working')
    const first = t.workers.check(PANE, 'turn-ended')
    t.set('none')
    const second = t.workers.check(PANE, 'turn-ended')
    await Promise.all([first, second])
    expect(t.told).toEqual([])
    expect(t.workers.runningOf(PANE)).toBe(false)
  })
})

describe('what a conversation’s workers are doing', () => {
  const host = (
    states: OrchestrationSessionWorkerState[],
    refusal: 'bot_paused' | null = null
  ) => ({
    workers: { read: async () => states.map((state) => ({ state })) },
    bots: { refusal: () => refusal, open: vi.fn(), workLinks: async () => [] }
  })

  it('is working while any works, else unverifiable while any is out of contact', async () => {
    await expect(
      conversationWorkerActivity(host(['completed', 'unverifiable', 'working']), LINK)
    ).resolves.toBe('working')
    await expect(
      conversationWorkerActivity(host(['completed', 'unverifiable']), LINK)
    ).resolves.toBe('unverifiable')
    await expect(conversationWorkerActivity(host(['completed', 'failed']), LINK)).resolves.toBe(
      'none'
    )
  })

  it('is none once the bot is paused', async () => {
    await expect(conversationWorkerActivity(host(['working'], 'bot_paused'), LINK)).resolves.toBe(
      'none'
    )
  })

  it('cannot be read without a workers host', async () => {
    await expect(conversationWorkerActivity({}, LINK)).resolves.toBeNull()
  })
})
