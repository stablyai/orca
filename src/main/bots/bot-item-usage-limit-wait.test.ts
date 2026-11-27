import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionStatusSummary } from '../../shared/agent-session/agent-session-wire'
import type { BotItemLinkView, BotItemWorkerState } from '../../shared/bots/bot-items'
import { type BotItemUsageLimitStore, BotItemUsageLimitWaits } from './bot-item-usage-limit-wait'
import type { BotItemBotActor } from './bot-items-input'
import type { WorkerRead } from './bot-items-link-join'
import type { BotItemLinkRecord } from './bot-items-schema'
import { BotItemsStore } from './bot-items-store'

const BOT: BotItemBotActor = { kind: 'bot', botId: 'bot', chatId: 'home' }
const HOUR = 3_600_000
const NOW = Date.UTC(2026, 10, 22, 12)

/** The store as the host reaches it: every call async; `down` fails its writes, as a busy file would. */
function remote(store: BotItemsStore, down: { writes: boolean }): BotItemUsageLimitStore {
  return {
    linkedDispatchRefs: async () => store.linkedDispatchRefs(),
    linksTo: async (kind, refs) => store.linksTo(kind, refs),
    viewRows: async (uids) => store.viewRows(uids),
    usageLimitWait: async (uid, text) => {
      if (down.writes) {
        throw new Error('database is locked')
      }
      return store.usageLimitWait(uid, text)
    },
    usageLimitWaitUids: async () => store.usageLimitWaitUids()
  }
}

function summary(
  sessionId: string,
  cut?: { resetsAt: number; continueAt?: number; state: 'scheduled' | 'off' | 'cancelled' },
  updatedAt = NOW
): AgentSessionStatusSummary {
  return {
    sessionId,
    workspaceId: 'shared-worktree',
    agent: 'claude',
    status: null,
    latestPrompt: '',
    updatedAt,
    ...(cut ? { usageLimitContinue: { turnItemId: 't', ...cut } } : {})
  }
}

describe('usage-limit Waiting', () => {
  const stores: BotItemsStore[] = []
  afterEach(() => stores.splice(0).forEach((store) => store.dispose()))

  /** One item, its workers by Dispatch with each one's session and state. */
  type Workers = Record<string, { session: string; state: BotItemWorkerState }>

  function setup(workers: Workers) {
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
    const down = { writes: false }
    const readLinkedWorkers = vi.fn(
      async (_refs: readonly string[]) => new Map<string, WorkerRead>()
    )
    const waits = new BotItemUsageLimitWaits({
      store: () => remote(store, down),
      join: {
        readLinkedWorkers,
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
      // `a2` continues `a`'s lineage.
      root: (sessionId) => sessionId.replace(/\d+$/, ''),
      changed: () => {}
    })
    const note = () => {
      const item = store.get(uid)!
      const event =
        item.waitEvent === null ? undefined : store.events(uid, item.waitEvent - 1, 1)[0]
      return item.status === 'waiting' ? String(event?.data.note) : item.status
    }
    return { store, uid, waits, note, down, readLinkedWorkers }
  }

  it('only resolves workers whose usage stop can change an item', async () => {
    const { store, uid, waits, readLinkedWorkers } = setup({
      active: { session: 'a', state: 'working' }
    })
    store.add(
      {
        ownerBotId: BOT.botId,
        chatId: BOT.chatId,
        source: { kind: 'home', title: null },
        title: 'Later',
        status: 'planned',
        links: [{ kind: 'dispatch', ref: 'later' }]
      },
      BOT
    )
    waits.saw({ type: 'snapshot', sessions: [summary('a')] }, NOW)
    await waits.settled()
    expect(readLinkedWorkers).not.toHaveBeenCalled()
    waits.saw(
      { type: 'status', session: summary('a', { resetsAt: NOW + HOUR, state: 'off' }) },
      NOW
    )
    await waits.settled()
    expect(readLinkedWorkers.mock.calls.map((call) => call[0])).toEqual([['active']])
    expect(store.get(uid)?.status).toBe('waiting')
  })

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
    const workers: Workers = {
      ctx_a: { session: 'a', state: 'working' },
      ctx_b: { session: 'b', state: 'working' }
    }
    const { waits, note } = setup(workers)
    const cut = summary('a', { resetsAt: NOW + HOUR, state: 'off' })
    waits.saw({ type: 'snapshot', sessions: [cut, summary('b')] }, NOW)
    await waits.settled()
    expect(note()).toBe('working')
    workers.ctx_b!.state = 'completed'
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

  it('goes back to In progress on the first snapshot after a restart once its stop is gone', async () => {
    const { store, uid, waits, note } = setup({ ctx_a: { session: 'a', state: 'working' } })
    store.usageLimitWait(uid, 'Claude usage resets Nov 22, 1:00 PM')
    expect(note()).toMatch(/usage resets/)
    waits.saw({ type: 'snapshot', sessions: [summary('a')] }, NOW)
    await waits.settled()
    expect(note()).toBe('working')
  })

  it('goes back to In progress once no stopped worker is linked, after an unlink too', async () => {
    const { store, uid, waits, note } = setup({})
    store.usageLimitWait(uid, 'Claude usage resets Nov 22, 1:00 PM')
    waits.saw({ type: 'snapshot', sessions: [] }, NOW)
    await waits.settled()
    expect(note()).toBe('working')
  })

  it('takes a running newer session of the lineage over the older one’s stop', async () => {
    const { waits, note } = setup({ ctx_a: { session: 'a', state: 'working' } })
    const stopped = summary('a', { resetsAt: NOW + HOUR, state: 'off' })
    waits.saw({ type: 'snapshot', sessions: [stopped] }, NOW)
    await waits.settled()
    expect(note()).toMatch(/usage resets/)
    waits.saw({ type: 'status', session: summary('a2', undefined, NOW + 1) }, NOW + 1)
    await waits.settled()
    expect(note()).toBe('working')
  })

  it('tries a failed pass that cleared the last stop again on the next tick', async () => {
    const { waits, note, down } = setup({ ctx_a: { session: 'a', state: 'working' } })
    waits.saw(
      { type: 'snapshot', sessions: [summary('a', { resetsAt: NOW + HOUR, state: 'off' })] },
      NOW
    )
    await waits.settled()
    expect(note()).toMatch(/usage resets/)
    down.writes = true
    waits.saw({ type: 'status', session: summary('a') }, NOW)
    await waits.settled()
    expect(note()).toMatch(/usage resets/)
    down.writes = false
    waits.tick(NOW + 60_000)
    await waits.settled()
    expect(note()).toBe('working')
  })
})
