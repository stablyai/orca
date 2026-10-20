import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  SidebarInputsChangedEvent,
  SidebarInputsReadResult
} from '../../../shared/sidebar-list/sidebar-inputs-feed-contract'
import { sidebarInputsReplied } from '../../../shared/sidebar-list/sidebar-inputs-feed-installer'
import { SidebarInputsFeed } from './sidebar-inputs-feed'
import { FEED_LOG_MAX_REVISIONS } from './sidebar-inputs-feed-log'
import { FEED_PIN_IDLE_MS, FEED_PIN_MAX_BATCHES } from './sidebar-inputs-feed-pins'
import { TestPhone, testDomain, truthOf } from './sidebar-inputs-feed.test-fixture'

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
  it('installs a snapshot, then a delta after a change', async () => {
    const host = makeHost()
    const phone = new TestPhone(host.feed, 'conn-1')
    phone.refresh()
    await phone.settle()
    expect(phone.replies.at(-1)?.kind).toBe('snapshot')
    expect(phone.view()).toEqual(host.truth())

    host.rows.set('b', 2)
    host.rows.remove('a')
    await flush()
    phone.notice(host.lastEvent())
    await phone.settle()
    expect(phone.replies.at(-1)).toMatchObject({
      kind: 'delta',
      domains: { rows: { upserts: { b: 2 }, removals: ['a'] } }
    })
    expect(phone.view()).toEqual(host.truth())
  })

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
    expect(phone.replies.map((reply) => reply.kind)).toEqual(['snapshot', 'snapshot', 'delta'])
    expect(phone.view()).toEqual(host.truth())
  })

  it('ignores a duplicate or late notice, and reads on a newer one', async () => {
    const host = makeHost()
    const phone = new TestPhone(host.feed, 'conn-1')
    phone.refresh()
    await phone.settle()
    host.rows.set('a', 2)
    await flush()
    const notice = host.lastEvent()
    phone.notice(notice)
    await phone.settle()

    phone.notice(notice)
    phone.notice({ ...notice, revision: notice.revision - 1 })
    expect(phone.pending).toBeNull()
    phone.notice({ ...notice, revision: notice.revision + 1 })
    expect(phone.pending?.params).toMatchObject({ cursor: notice.revision })
  })

  it('publishes a change after a quiet spell at once and the rest of its burst together', async () => {
    const host = makeHost()
    const phone = new TestPhone(host.feed, 'conn-1')
    phone.refresh()
    await phone.settle()
    await vi.advanceTimersByTimeAsync(100)
    const before = host.events.length
    host.rows.set('a', 2)
    await vi.advanceTimersByTimeAsync(1)
    expect(host.events).toHaveLength(before + 1)
    host.rows.set('a', 3)
    host.rows.set('a', 4)
    await vi.advanceTimersByTimeAsync(40)
    expect(host.events).toHaveLength(before + 1)
    await vi.advanceTimersByTimeAsync(20)
    expect(host.events).toHaveLength(before + 2)
    phone.notice(host.lastEvent())
    await phone.settle()
    expect(phone.view()).toEqual(host.truth())
  })

  it('coalesces notices into one read in flight and one more after it', async () => {
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
    expect(phone.replies.map((reply) => reply.kind)).toEqual(['snapshot', 'delta'])
    expect(phone.view()).toEqual(host.truth())
  })

  it('needs no second read when the reply already covers a notice', async () => {
    const host = makeHost()
    const phone = new TestPhone(host.feed, 'conn-1')
    phone.refresh()
    await phone.settle()
    host.rows.set('a', 2)
    await flush()
    phone.refresh()
    phone.notice(host.lastEvent())
    await phone.settle()
    expect(phone.replies).toHaveLength(2)
    expect(phone.view()).toEqual(host.truth())
  })

  it('drops a reply to a request it no longer waits on', async () => {
    const host = makeHost()
    const phone = new TestPhone(host.feed, 'conn-1')
    phone.refresh()
    const stale = phone.pending
    phone.disconnect()
    phone.feed.acquire(phone.connectionId)
    phone.refresh()
    if (!stale) {
      throw new Error('expected a read')
    }
    const reply = await host.feed.read(stale.params)
    expect(sidebarInputsReplied(phone.state, stale.id, reply).state).toBe(phone.state)
  })

  it('reads a snapshot when a delta does not start at the installed revision', async () => {
    const host = makeHost()
    const phone = new TestPhone(host.feed, 'conn-1')
    phone.refresh()
    await phone.settle()
    host.rows.set('a', 2)
    await flush()
    phone.notice(host.lastEvent())
    const request = phone.pending
    if (!request) {
      throw new Error('expected a read')
    }
    const reply = await host.feed.read(request.params)
    const step = sidebarInputsReplied(phone.state, request.id, {
      ...reply,
      from: (reply.from ?? 0) - 1
    })
    expect(step.state.installed).toBe(phone.state.installed)
    expect(step.request?.params).toEqual({ maxBytes: expect.any(Number) })
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
    expect(host.rows.reads()).toBe(2)

    phone.feed.acquire('conn-2')
    phone.refresh()
    await phone.settle()
    expect(phone.replies.at(-1)?.kind).toBe('snapshot')
    expect(phone.view()).toEqual(host.truth())
  })

  it('reads a delta over a re-paired connection while the session lives on', async () => {
    const host = makeHost()
    const other = new TestPhone(host.feed, 'conn-other')
    const phone = new TestPhone(host.feed, 'conn-1')
    phone.refresh()
    await phone.settle()
    phone.disconnect()
    host.rows.set('a', 2)
    await flush()

    phone.feed.acquire('conn-repaired')
    phone.refresh()
    await phone.settle()
    expect(phone.replies.at(-1)?.kind).toBe('delta')
    expect(phone.view()).toEqual(host.truth())
    other.disconnect()
  })

  it('serves two phones from one session, which ends with the last of them', async () => {
    const host = makeHost()
    const first = new TestPhone(host.feed, 'conn-1')
    const second = new TestPhone(host.feed, 'conn-2')
    first.refresh()
    second.refresh()
    await Promise.all([first.settle(), second.settle()])
    expect(host.rows.reads()).toBe(1)

    first.disconnect()
    host.rows.set('a', 2)
    await flush()
    second.notice(host.lastEvent())
    await second.settle()
    expect(second.view()).toEqual(host.truth())

    second.disconnect()
    expect(host.rows.watchers()).toBe(0)
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
    expect(phone.replies.length).toBeGreaterThan(2)
    expect(phone.view()).toEqual(host.truth())

    for (let index = 0; index < 2_000; index += 1) {
      host.rows.set(`row-${index}`, { name: `workspace ${index}`.padEnd(300, '.') })
    }
    await flush()
    phone.notice(host.lastEvent())
    const before = phone.replies.length
    await phone.settle()
    expect(phone.replies.slice(before).every((reply) => reply.kind === 'delta')).toBe(true)
    expect(phone.replies.length - before).toBeGreaterThan(1)
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

  it('re-reads a failed domain on the next read without retrying on its own', async () => {
    const host = makeHost()
    const phone = new TestPhone(host.feed, 'conn-1')
    phone.refresh()
    await phone.settle()
    host.rows.fail(true)
    host.rows.set('a', 2)
    await flush()
    const failedReads = host.rows.reads()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(host.rows.reads()).toBe(failedReads)

    host.rows.fail(false)
    phone.refresh()
    await phone.settle()
    expect(host.rows.reads()).toBe(failedReads + 1)
    expect(phone.view()).toEqual(host.truth())
  })

  it('re-reads a failed domain with the next flush another domain causes', async () => {
    const host = makeHost()
    const phone = new TestPhone(host.feed, 'conn-1')
    phone.refresh()
    await phone.settle()
    host.rows.fail(true)
    host.rows.set('a', 2)
    await flush()
    host.rows.fail(false)
    host.view.set('sort', 'recent')
    await flush()
    phone.notice(host.lastEvent())
    await phone.settle()
    expect(phone.view()).toEqual(host.truth())
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

  it('reads nothing and announces nothing until a phone subscribes', async () => {
    const host = makeHost()
    host.rows.set('a', 2)
    await flush()
    expect(host.rows.reads()).toBe(0)
    expect(host.rows.watchers()).toBe(0)
    expect(host.events).toEqual([])
  })

  it('re-reads a quiet source on every read, and joins concurrent reads into one flush', async () => {
    const quiet = testDomain('quiet', { a: 1 }, { rereadOnRead: true })
    const feed = new SidebarInputsFeed(
      () => [quiet.domain],
      () => {}
    )
    feed.acquire('conn-1')
    await feed.read({ maxBytes: 1 })
    quiet.setQuietly('a', 2)
    const release = quiet.hold()
    const reads = [feed.read({ maxBytes: 1 }), feed.read({ maxBytes: 1 })]
    release()
    const [first, second] = await Promise.all(reads)
    expect(quiet.reads()).toBe(3)
    expect(first).toMatchObject({ kind: 'snapshot', domains: { quiet: { upserts: { a: 2 } } } })
    expect(second.revision).toBe(first.revision)
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
