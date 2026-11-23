import { afterEach, describe, expect, it } from 'vitest'
import type { AgentSessionStatusSummary } from '../../shared/agent-session/agent-session-wire'
import type { BotItemLinkView, BotItemWorkerState } from '../../shared/bots/bot-items'
import { BotItemUsageLimitWaits } from './bot-item-usage-limit-wait'
import type { BotItemBotActor } from './bot-items-input'
import type { WorkerRead } from './bot-items-link-join'
import type { BotItemsRemote } from './bot-items-ops'
import type { BotItemLinkRecord } from './bot-items-schema'
import { BotItemsStore } from './bot-items-store'
import type { BotWorkWorker } from './bot-work-types'

const BOT: BotItemBotActor = { kind: 'bot', botId: 'bot', chatId: 'home' }
const HOUR = 3_600_000
const NOW = Date.UTC(2026, 10, 22, 12)

/** The store as the host reaches it: every call async. */
function remote(store: BotItemsStore): BotItemsRemote {
  return new Proxy(store, {
    get: (target, op) => {
      const value: unknown = Reflect.get(target, op)
      return typeof value === 'function'
        ? (...args: unknown[]) => Promise.resolve(value.apply(target, args))
        : value
    }
  }) as unknown as BotItemsRemote
}

function summary(
  sessionId: string,
  cut?: { resetsAt: number; continueAt?: number; state: 'scheduled' | 'off' | 'cancelled' }
): AgentSessionStatusSummary {
  return {
    sessionId,
    workspaceId: 'shared-worktree',
    agent: 'claude',
    status: null,
    latestPrompt: '',
    updatedAt: NOW,
    ...(cut ? { usageLimitContinue: { turnItemId: 't', ...cut } } : {})
  } as AgentSessionStatusSummary
}

describe('usage-limit Waiting', () => {
  const stores: BotItemsStore[] = []
  afterEach(() => stores.splice(0).forEach((store) => store.dispose()))

  /** One item, its workers by Dispatch with each one's session and state. */
  function setup(workers: Record<string, { session: string; state: BotItemWorkerState }>) {
    const store = BotItemsStore.open(':memory:')
    stores.push(store)
    const { uid } = store.add(
      {
        ownerBotId: BOT.botId,
        chatId: BOT.chatId,
        source: { kind: 'home', title: null },
        title: 'Ship it',
        status: 'working',
        links: Object.keys(workers).map((ref) => ({ kind: 'dispatch' as const, ref }))
      },
      BOT
    )
    const waits = new BotItemUsageLimitWaits({
      store: () => remote(store),
      join: {
        readLinkedWorkers: async (refs: readonly string[]) =>
          new Map<string, WorkerRead>(
            refs.map((ref) => [
              ref,
              { worker: { dispatchId: ref } as BotWorkWorker, pr: null, report: null }
            ])
          ),
        linkView: (link: BotItemLinkRecord): BotItemLinkView => ({
          kind: 'dispatch',
          ref: link.ref,
          latest: null,
          title: null,
          state: workers[link.ref]!.state,
          host: null,
          startedAt: null,
          settledAt: null,
          report: null,
          pr: null
        })
      },
      sessionOf: (dispatchId) => workers[dispatchId]?.session ?? null,
      root: (sessionId) => sessionId,
      changed: () => {}
    })
    const note = () => {
      const item = store.get(uid)!
      const event =
        item.waitEvent === null ? undefined : store.events(uid, item.waitEvent - 1, 1)[0]
      return item.status === 'waiting' ? String(event?.data.note) : item.status
    }
    return { store, uid, waits, note }
  }

  it('waits on the stopped worker’s own session, not another session in its worktree', async () => {
    const { waits, note } = setup({ ctx_a: { session: 'a', state: 'working' } })
    waits.saw(
      {
        type: 'snapshot',
        sessions: [summary('a'), summary('other', { resetsAt: NOW + HOUR, state: 'off' })]
      },
      NOW
    )
    await waits.settled()
    expect(note()).toBe('working')
    waits.saw(
      { type: 'status', session: summary('a', { resetsAt: NOW + HOUR, state: 'off' }) },
      NOW
    )
    await waits.settled()
    expect(note()).toMatch(/^Claude usage resets /)
  })

  it('says when Orca really continues, its continueAt', async () => {
    const { waits, note } = setup({ ctx_a: { session: 'a', state: 'working' } })
    const continueAt = NOW + 3 * HOUR
    waits.saw(
      {
        type: 'snapshot',
        sessions: [summary('a', { resetsAt: NOW + HOUR, continueAt, state: 'scheduled' })]
      },
      NOW
    )
    await waits.settled()
    const when = new Intl.DateTimeFormat(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit'
    }).format(new Date(continueAt))
    expect(note()).toBe(`Claude continues ${when}`)
  })

  it('goes back to In progress once a reset with no continue passes, on the next tick', async () => {
    const { waits, note } = setup({ ctx_a: { session: 'a', state: 'working' } })
    const cut = summary('a', { resetsAt: NOW + HOUR, state: 'cancelled' })
    waits.saw({ type: 'snapshot', sessions: [cut] }, NOW)
    await waits.settled()
    expect(note()).toMatch(/usage resets/)
    waits.tick(NOW + 2 * HOUR)
    await waits.settled()
    expect(note()).toBe('working')
  })

  it('waits once the other worker on the item finishes', async () => {
    const workers = {
      ctx_a: { session: 'a', state: 'working' as BotItemWorkerState },
      ctx_b: { session: 'b', state: 'working' as BotItemWorkerState }
    }
    const { waits, note } = setup(workers)
    const cut = summary('a', { resetsAt: NOW + HOUR, state: 'off' })
    waits.saw({ type: 'snapshot', sessions: [cut, summary('b')] }, NOW)
    await waits.settled()
    expect(note()).toBe('working')
    workers.ctx_b.state = 'completed'
    waits.recheck()
    await waits.settled()
    expect(note()).toMatch(/usage resets/)
  })

  it('waits when an item whose worker already stopped becomes In progress', async () => {
    const { store, uid, waits, note } = setup({ ctx_a: { session: 'a', state: 'working' } })
    store.set(uid, { status: 'planned' }, BOT)
    waits.saw(
      { type: 'snapshot', sessions: [summary('a', { resetsAt: NOW + HOUR, state: 'off' })] },
      NOW
    )
    await waits.settled()
    expect(note()).toBe('planned')
    store.set(uid, { status: 'working' }, BOT)
    waits.recheck()
    await waits.settled()
    expect(note()).toMatch(/usage resets/)
  })
})
