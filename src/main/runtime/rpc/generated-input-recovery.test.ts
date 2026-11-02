import './unused-default-rpc-methods.test-fixture'
import { expect, it, vi } from 'vitest'
import { GeneratedAgentInputNotices } from '../generated-agent-input-notices'
import { GENERATED_INPUT_METHODS } from './methods/generated-input'
import { eraseRpcMethods, type RpcContext, type RpcMethod } from './core'
import {
  createGeneratedInputNoticeFeed,
  type GeneratedInputNoticeDelta
} from '../../../shared/generated-input-notice-feed'
import type { GeneratedAgentInputNotice } from '../../../shared/generated-agent-input-notice'
import { GeneratedInputNoticeProjection } from '../../../shared/generated-input-notice-projection'
import { REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES } from '../../../shared/remote-runtime/remote-runtime-memory-limits'

function harness() {
  const notices = new GeneratedAgentInputNotices()
  const cleanups = new Map<string, () => void>()
  const runtime = {
    generatedInputNotices: notices,
    registerSubscriptionCleanup: (id: string, cleanup: () => void) => cleanups.set(id, cleanup),
    cleanupSubscription: (id: string) => cleanups.get(id)?.()
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these handlers only consume the notice owner and subscription registry above.
  const context = { runtime, connectionId: 'viewer' } as unknown as RpcContext
  const methods = eraseRpcMethods(GENERATED_INPUT_METHODS)
  const find = (name: string) => {
    const found = methods.find((entry) => entry.name === name)
    if (!found) {
      throw new Error(`missing ${name}`)
    }
    return found
  }
  const method = (name: string): RpcMethod => {
    const found = find(name)
    if ('stream' in found) {
      throw new Error(`${name} is streaming`)
    }
    return found
  }
  const subscribe = find('terminal.generatedInputNotices.subscribe')
  const page = method('terminal.generatedInputNotices.page')
  const dismiss = method('terminal.dismissGeneratedInputNotice')
  const wire: string[] = []
  const views: GeneratedAgentInputNotice[][] = []
  const view = new Map<string, GeneratedAgentInputNotice>()
  const deltas: GeneratedInputNoticeDelta[] = []
  let snapshots = 0
  const pageReads: (() => void)[] = []
  let holdPages = false
  let pageCalls = 0
  // Stream messages a lossy link drops before this client sees them.
  let drop = (_message: unknown) => false
  const feed = createGeneratedInputNoticeFeed({
    readPage: async (from) => {
      if (holdPages) {
        await new Promise<void>((resolve) => pageReads.push(resolve))
      }
      pageCalls += 1
      const result = await page.handler(from ?? {}, context)
      wire.push(JSON.stringify(result))
      return result
    },
    // The consumer's indexed view, recorded after each snapshot or delta.
    onSnapshot: (current) => {
      snapshots += 1
      view.clear()
      for (const notice of current) {
        view.set(notice.id, notice)
      }
      views.push([...view.values()])
    },
    onDelta: (delta) => {
      if (delta.kind === 'added') {
        view.set(delta.notice.id, delta.notice)
      } else {
        view.delete(delta.id)
      }
      deltas.push(delta)
      views.push([...view.values()])
    }
  })
  const connect = () =>
    'stream' in subscribe
      ? subscribe.handler(null, context, (message) => {
          wire.push(JSON.stringify(message))
          if (!drop(message)) {
            feed.receive(message)
          }
        })
      : Promise.reject(new Error('not a stream'))
  const add = (text: string) =>
    notices.add({
      agent: 'claude',
      text,
      handle: 'h',
      worktreeId: 'w',
      ptyId: null,
      certainty: 'not-sent'
    })
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
  return {
    notices,
    cleanups,
    context,
    dismiss,
    wire,
    views,
    deltas,
    snapshots: () => snapshots,
    connect,
    add,
    settle,
    pageReads,
    pageCalls: () => pageCalls,
    dropWhen: (predicate: (message: unknown) => boolean) => (drop = predicate),
    hold: (on: boolean) => (holdPages = on)
  }
}

it('reconnects to retained prompts far above the paired-transport cap in bounded frames, text exact', async () => {
  const h = harness()
  // Eight legal 512 KiB prompts once made a single 4.19 MB list event that closed the phone's session.
  const texts = Array.from({ length: 8 }, (_, i) => `${i}\n${'é"\\'.repeat((512 * 1024) / 3)}`)
  for (const text of texts) {
    h.add(text)
  }
  void h.connect()
  await h.settle()
  await h.settle()
  const last = h.views.at(-1)!
  expect(last.map((notice) => notice.text)).toEqual(texts)
  for (const frame of h.wire) {
    expect(Buffer.byteLength(frame)).toBeLessThan(REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES / 2)
  }
  // A later add sends only itself.
  h.wire.length = 0
  h.add('one more')
  expect(h.wire.join('')).not.toContain(texts[0].slice(0, 64))
  expect(
    h.views
      .at(-1)!
      .map((notice) => notice.text)
      .at(-1)
  ).toBe('one more')
  for (const cleanup of h.cleanups.values()) {
    cleanup()
  }
})

it('never revives a notice dismissed while the snapshot is still paging, and dismissal is idempotent', async () => {
  const h = harness()
  h.add('first')
  h.add('second')
  const [first] = [...h.notices.page().frames]
  h.hold(true)
  void h.connect()
  await h.settle()
  // Another client dismisses before this client's first page is served.
  await h.dismiss.handler({ id: first.id }, h.context)
  await h.dismiss.handler({ id: first.id }, h.context)
  h.add('third')
  h.hold(false)
  h.pageReads.splice(0).forEach((release) => release())
  await h.settle()
  await h.settle()
  expect(
    h.views
      .at(-1)!
      .map((notice) => notice.text)
      .toSorted()
  ).toEqual(['second', 'third'])
  for (const cleanup of h.cleanups.values()) {
    cleanup()
  }
})

// Thousands of small notices once cost a rescan per page and a full republication per frame.
async function snapshotCost(tiny: number) {
  const h = harness()
  const large = Array.from({ length: 3 }, (_, i) => `${i}${'x'.repeat(700 * 1024)}`)
  const texts = [
    ...Array.from({ length: tiny / 2 }, (_, i) => `t${i}`),
    ...large,
    ...Array.from({ length: tiny / 2 }, (_, i) => `u${i}`)
  ]
  for (const text of texts) {
    h.add(text)
  }
  void h.connect()
  for (let i = 0; i < 20 && h.views.length === 0; i += 1) {
    await h.settle()
  }
  expect(h.views).toHaveLength(1)
  expect(h.views[0].map((notice) => notice.text)).toEqual(texts)
  for (const frame of h.wire) {
    expect(Buffer.byteLength(frame)).toBeLessThan(REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES / 2)
  }
  for (const cleanup of h.cleanups.values()) {
    cleanup()
  }
  return { visits: h.notices.pageVisits, pages: h.pageCalls(), count: texts.length }
}

it('pages 30,000 tiny notices plus large ones exactly, with work linear in what is sent', async () => {
  const small = await snapshotCost(3_000)
  const big = await snapshotCost(30_000)
  // Each page visits its notices once, plus the split notice it resumes.
  expect(small.visits).toBeLessThanOrEqual(small.count + small.pages)
  expect(big.visits).toBeLessThanOrEqual(big.count + big.pages)
  expect(big.pages).toBeLessThan(small.pages * 10 + 3)
})

it('reads the host again after a dropped change, keeping additions and dismissals', async () => {
  const h = harness()
  h.add('first')
  h.add('second')
  void h.connect()
  await h.settle()
  await h.settle()
  const [first] = [...h.notices.page().frames]
  h.dropWhen(
    (message) =>
      typeof message === 'object' &&
      message !== null &&
      'type' in message &&
      message.type === 'dismissed'
  )
  h.notices.dismiss(first.id)
  h.dropWhen(() => false)
  h.add('third')
  await h.settle()
  await h.settle()
  expect(h.views.at(-1)!.map((notice) => notice.text)).toEqual(['second', 'third'])
  for (const cleanup of h.cleanups.values()) {
    cleanup()
  }
})

// A detached draft's notice keeps its draft meaning across the wire, so clients say "notes".
it('carries an unsubmitted draft through frames and pages, and reads older notices as prompts', async () => {
  const h = harness()
  h.notices.add({
    agent: 'claude',
    text: 'draft text',
    handle: 'h',
    worktreeId: 'w',
    ptyId: null,
    certainty: 'not-sent',
    submitted: false
  })
  h.add('a prompt')
  void h.connect()
  await h.settle()
  await h.settle()
  expect(h.views.at(-1)!.map(({ text, submitted }) => ({ text, submitted }))).toEqual([
    { text: 'draft text', submitted: false },
    { text: 'a prompt', submitted: undefined }
  ])
  for (const cleanup of h.cleanups.values()) {
    cleanup()
  }
})

// K6: after the snapshot, one live add and its dismissal touch only that notice on the client:
// no complete-view rebuild, whatever the retained population.
async function liveChangeCost(population: number) {
  const h = harness()
  for (let i = 0; i < population; i += 1) {
    h.add(`t${i}`)
  }
  void h.connect()
  for (let i = 0; i < 20 && h.snapshots() === 0; i += 1) {
    await h.settle()
  }
  expect(h.snapshots()).toBe(1)
  const rebuilds = vi.spyOn(GeneratedInputNoticeProjection.prototype, 'complete')
  h.add('x')
  const added = h.deltas.at(-1)
  expect(added?.kind).toBe('added')
  h.notices.dismiss(added?.kind === 'added' ? added.notice.id : '')
  const cost = { rebuilds: rebuilds.mock.calls.length, deltas: h.deltas.length }
  rebuilds.mockRestore()
  expect(h.snapshots()).toBe(1)
  for (const cleanup of h.cleanups.values()) {
    cleanup()
  }
  return cost
}

it('applies one live add and dismissal as two deltas at 3,000 and 30,000 retained notices', async () => {
  for (const population of [3_000, 30_000]) {
    expect(await liveChangeCost(population)).toEqual({ rebuilds: 0, deltas: 2 })
  }
})

// K8: dismissals through the compaction threshold keep the seek index linear in live notices, a
// survivor snapshot visits only what it sends plus that bounded index, and every client receives
// one change carrying one notice.
it('keeps the index bounded across dismissals and fans one change out once per client', async () => {
  for (const population of [3_000, 30_000]) {
    const notices = new GeneratedAgentInputNotices()
    for (let i = 0; i < population; i += 1) {
      notices.add({
        agent: 'claude',
        text: `t${i}`,
        handle: 'h',
        worktreeId: 'w',
        ptyId: null,
        certainty: 'not-sent'
      })
    }
    // Dismiss nine in ten, oldest first, through repeated compactions.
    let all: string[] = []
    for (
      let cursor: { cursor: number; offset: number } | null = { cursor: 0, offset: 0 };
      cursor;
    ) {
      const page = notices.page(cursor.cursor, cursor.offset)
      all = all.concat(page.frames.filter((frame) => frame.offset === 0).map((frame) => frame.id))
      cursor = page.next
    }
    const live = population / 10
    for (const id of all.slice(0, population - live)) {
      notices.dismiss(id)
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: reads the owner's private seek index to bound it.
    const order = (notices as unknown as { order: unknown[] }).order
    expect(order.length).toBeLessThanOrEqual(2 * live + 16)
    notices.pageVisits = 0
    let pages = 0
    for (
      let cursor: { cursor: number; offset: number } | null = { cursor: 0, offset: 0 };
      cursor;
    ) {
      const page = notices.page(cursor.cursor, cursor.offset)
      pages += 1
      cursor = page.next
    }
    expect(notices.pageVisits).toBeLessThanOrEqual(order.length + pages)

    const received = Array.from({ length: 100 }, () => [] as unknown[])
    const unsubscribe = received.map((changes) =>
      notices.subscribe((change) => changes.push(change))
    )
    notices.add({
      agent: 'claude',
      text: 'one more',
      handle: 'h',
      worktreeId: 'w',
      ptyId: null,
      certainty: 'not-sent'
    })
    for (const changes of received) {
      expect(changes).toHaveLength(1)
      expect(changes[0]).toMatchObject({ kind: 'added', notice: { text: 'one more' } })
    }
    unsubscribe.forEach((stop) => stop())
  }
})
