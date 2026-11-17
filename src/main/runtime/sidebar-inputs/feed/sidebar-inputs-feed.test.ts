import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  SidebarInputsChangedEvent,
  SidebarInputsReadResult
} from '../../../../shared/sidebar-list/feed/sidebar-inputs-feed-contract'
import '../../../../shared/sidebar-list/feed/sidebar-inputs-feed-installer'
import { SidebarInputsFeed } from './sidebar-inputs-feed'
import { FEED_LOG_MAX_REVISIONS } from './sidebar-inputs-feed-log'
import { FEED_PIN_IDLE_MS, FEED_PIN_MAX_BATCHES } from './sidebar-inputs-feed-pins'
import { TestPhone, testDomain, truthOf } from './testing/sidebar-inputs-feed.test-fixture'

// Three ~100 KiB entities: a snapshot of them spans two 256 KiB pages.
const BIG = 'x'.repeat(100 * 1024)

function makeHost(initial: Record<string, unknown> = { a: 1 }) {
  const rows = testDomain('rows', initial)
  const view = testDomain('view', { sort: 'name' })
  const events: SidebarInputsChangedEvent[] = []
  const feed = new SidebarInputsFeed(
    () => [rows.domain, view.domain],
    (event) => events.push(event)
  )
  const lastEvent = (): SidebarInputsChangedEvent => {
    const event = events.at(-1)
    if (!event) {
      throw new Error('no change notice yet')
    }
    return event
  }
  return { rows, view, feed, events, lastEvent, truth: () => truthOf(rows, view) }
}

/** Lets the feed coalesce and publish what the domains announced. */
const flush = () => vi.advanceTimersByTimeAsync(60)

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('sidebar inputs feed', () => {
  it('installs a paged snapshot whole, then catches up a change made while paging', async () => {
    const host = makeHost({ a: BIG, b: BIG, c: BIG })
    const phone = new TestPhone(host.feed, 'conn-1')
    phone.refresh()
    const first = await phone.answerOne()
    expect(first.next).not.toBeNull()
    expect(phone.state.installed).toBeNull()

    host.rows.set('d', 'late')
    await flush()
    phone.notice(host.lastEvent())
    await phone.settle()

    expect(phone.view()).toEqual(host.truth())
  })

  it('catches up notices arriving while a read is in flight', async () => {
    const host = makeHost()
    const phone = new TestPhone(host.feed, 'conn-1')
    phone.refresh()
    const served = await phone.serveOne()
    for (let value = 2; value < 5; value += 1) {
      host.rows.set('a', value)
      await flush()
      phone.notice(host.lastEvent())
    }
    expect(phone.pending).toBeNull()
    served.deliver()
    await phone.settle()

    expect(phone.view()).toEqual(host.truth())
  })

  it('reads a snapshot once the cursor fell out of the log', async () => {
    const host = makeHost()
    const phone = new TestPhone(host.feed, 'conn-1')
    phone.refresh()
    await phone.settle()
    for (let value = 0; value <= FEED_LOG_MAX_REVISIONS; value += 1) {
      host.rows.set('a', value)
      await flush()
    }
    phone.notice(host.lastEvent())
    await phone.settle()
    expect(phone.replies.at(-1)?.kind).toBe('snapshot')
    expect(phone.view()).toEqual(host.truth())
  })

  it('starts over when a pinned snapshot expired mid-paging', async () => {
    const host = makeHost({ a: BIG, b: BIG, c: BIG })
    const phone = new TestPhone(host.feed, 'conn-1')
    phone.refresh()
    await phone.answerOne()
    await vi.advanceTimersByTimeAsync(FEED_PIN_IDLE_MS + 1)
    expect((await phone.answerOne()).kind).toBe('reset')
    await phone.settle()
    expect(phone.view()).toEqual(host.truth())
  })

  it('keeps what it installed across a disconnect and reads a snapshot from a new session', async () => {
    const host = makeHost({ a: BIG, b: BIG, c: BIG })
    const phone = new TestPhone(host.feed, 'conn-1')
    phone.refresh()
    await phone.settle()
    const installed = phone.state.installed

    host.rows.set('d', 1)
    await flush()
    phone.notice(host.lastEvent())
    expect(phone.pending).not.toBeNull()
    phone.disconnect()
    expect(phone.state.installed).toBe(installed)

    // The last subscriber left: the session's state and watches are gone.
    expect(host.rows.watchers()).toBe(0)
    host.rows.set('e', 1)

    phone.feed.acquire('conn-2')
    phone.refresh()
    await phone.settle()
    expect(phone.replies.at(-1)?.kind).toBe('snapshot')
    expect(phone.view()).toEqual(host.truth())
  })

  it('replaces everything after a runtime restart, whose generation is new', async () => {
    const host = makeHost()
    const phone = new TestPhone(host.feed, 'conn-1')
    phone.refresh()
    await phone.settle()

    const restarted = makeHost({ z: 1 })
    phone.feed = restarted.feed
    restarted.feed.acquire('conn-1')
    phone.notice({ generation: restarted.feed.generation, revision: 1 })
    expect(phone.pending?.params).toMatchObject({ generation: host.feed.generation })
    await phone.settle()
    expect(phone.replies.at(-1)?.kind).toBe('snapshot')
    expect(phone.state.installed?.generation).toBe(restarted.feed.generation)
    expect(phone.view()).toEqual(restarted.truth())
  })

  it('sends an entity larger than a page as parts, and a large revision as a paged delta', async () => {
    const rankedIds = Array.from(
      { length: 10_000 },
      (_, index) => `runtime:env-${index}::/w/${index}`
    )
    const host = makeHost({ order: { rankedIds } })
    const phone = new TestPhone(host.feed, 'conn-1')
    phone.refresh()
    await phone.settle()

    expect(phone.view()).toEqual(host.truth())

    for (let index = 0; index < 2_000; index += 1) {
      host.rows.set(`row-${index}`, { name: `workspace ${index}`.padEnd(300, '.') })
    }
    await flush()
    phone.notice(host.lastEvent())
    await phone.settle()

    expect(phone.view()).toEqual(host.truth())
  })

  it('keeps a domain as last published when its read fails', async () => {
    const host = makeHost()
    const phone = new TestPhone(host.feed, 'conn-1')
    phone.refresh()
    await phone.settle()
    host.rows.fail(true)
    host.rows.set('a', 2)
    await flush()
    phone.refresh()
    await phone.settle()
    expect(phone.view().rows).toEqual({ a: 1 })
  })

  it('bounds pinned batches, evicting the oldest', async () => {
    const host = makeHost({ a: BIG, b: BIG, c: BIG })
    host.feed.acquire('conn-1')
    const firsts: SidebarInputsReadResult[] = []
    for (let index = 0; index <= FEED_PIN_MAX_BATCHES; index += 1) {
      // A different page size is a different batch.
      firsts.push(await host.feed.read({ maxBytes: 200 * 1024 + index }))
    }
    const oldest = firsts[0].next
    const newest = firsts.at(-1)?.next
    if (!oldest || !newest) {
      throw new Error('expected paged batches')
    }
    expect((await host.feed.read({ pageToken: oldest, maxBytes: 1 })).kind).toBe('reset')
    expect((await host.feed.read({ pageToken: newest, maxBytes: 1 })).kind).toBe('snapshot')
  })

  it('serves a phone read from the cache and waits only on a domain not yet ready', async () => {
    const host = makeHost()
    host.feed.acquire('conn-1')
    const release = host.rows.hold()
    let answered = false
    const read = host.feed.read({ maxBytes: 1 }).then((reply) => {
      answered = true
      return reply
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(answered).toBe(false)
    release()
    expect((await read).kind).toBe('snapshot')
  })

  it('keeps a not-yet-ready domain unpublished until its producer announces', async () => {
    let snapshot: Record<string, unknown> | null = null
    const watchers = new Set<() => void>()
    const events: SidebarInputsChangedEvent[] = []
    const feed = new SidebarInputsFeed(
      () => [
        {
          name: 'late',
          read: () => snapshot,
          watch: (changed) => {
            watchers.add(changed)
            return () => watchers.delete(changed)
          }
        }
      ],
      (event) => events.push(event)
    )
    feed.acquire('conn-1')
    expect((await feed.read({ maxBytes: 1 })).domains).toEqual({})
    snapshot = { a: 1 }
    watchers.forEach((changed) => changed())
    await flush()

    expect((await feed.read({ maxBytes: 1 })).domains).toMatchObject({
      late: { upserts: { a: 1 } }
    })
  })

  it('answers reset to a read whose session ended while it waited', async () => {
    const host = makeHost()
    host.feed.acquire('conn-1')
    const release = host.rows.hold()
    const read = host.feed.read({ maxBytes: 1 })
    host.feed.release('conn-1')
    release()
    expect((await read).kind).toBe('reset')
  })

  it('refuses a page token from a session that ended', async () => {
    const host = makeHost({ a: BIG, b: BIG, c: BIG })
    host.feed.acquire('conn-1')
    const first = await host.feed.read({ maxBytes: 1 })
    host.feed.release('conn-1')
    host.feed.acquire('conn-2')
    if (!first.next) {
      throw new Error('expected a paged snapshot')
    }
    expect((await host.feed.read({ pageToken: first.next, maxBytes: 1 })).kind).toBe('reset')
  })

  it('reads a snapshot past a revision larger than the whole log', async () => {
    const host = makeHost()
    const phone = new TestPhone(host.feed, 'conn-1')
    phone.refresh()
    await phone.settle()
    for (let index = 0; index < 30; index += 1) {
      host.rows.set(`big-${index}`, BIG)
    }
    await flush()
    phone.notice(host.lastEvent())
    await phone.settle()
    expect(phone.replies.at(-1)?.kind).toBe('snapshot')
    expect(phone.view()).toEqual(host.truth())
  })
})
