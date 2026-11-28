// How a saved line that may or may not be in the thread is counted when it is sent, dropped or
// its run stops.
import { describe, expect, it } from 'vitest'
import type { ConnectorReplyBody } from '../../connector-cloud/connector-replies'
import { closeTestStores, createStore } from '../../persistence/persistence-test-harness'
import { findLink } from '../external-conversation-links'
import { writeLinkFact } from '../external-conversation-link-writes'
import { THREAD_STATUS_STOP_LINE } from './thread-status-decide'
import { statusReplyId } from './thread-status-fact'
import {
  botHome,
  DM,
  harness,
  MIN,
  PANE,
  START,
  THREAD,
  setUpThreadStatusDirs,
  view
} from './thread-status-test-harness'

setUpThreadStatusDirs()

describe('ThreadStatus saved lines', () => {
  it('replaces a saved line older than 10 minutes that never went out under the next id', async () => {
    // Saved while the cloud had not said hello, so this process knows it never went out.
    let hello = false
    const sent: ConnectorReplyBody[] = []
    const run = harness(botHome(), {
      cloud: () => ({
        cloudFeatures: () => (hello ? new Set<string>() : null),
        reply: (body) => {
          sent.push(body)
          run.status.observed('/v1/connector/replies', { v: 1, ...body }, { ok: true, value: {} })
          return Promise.resolve({ ok: true as const })
        }
      })
    })
    await run.turnEnded()
    await run.advance(41 * MIN)
    expect(run.fact()?.pending?.replyId).toBe(statusReplyId(THREAD, START, 2))
    hello = true
    await run.advance(MIN)
    expect(sent.map((body) => [body.replyId, body.text])).toEqual([
      [statusReplyId(THREAD, START, 2), 'Still working on this (41 min).']
    ])
  })

  it('counts a dropped line that went out with no answer, so none follows it too soon', async () => {
    // The cloud may have taken the line before it failed; a turn then holds the retry for 15 min.
    const run = harness(botHome(), { answers: [{ ok: false, status: null, error: null }] })
    await run.turnEnded()
    await run.advance(30 * MIN)
    run.clock.running = run.clock.now
    await run.advance(15 * MIN)
    run.clock.running = null
    await run.advance(MIN)
    expect(run.fact()?.pending).toBeUndefined()
    expect(run.fact()).toMatchObject({
      seq: 1,
      dayCount: 1,
      armed: { lastLineAt: START + 46 * MIN, dueStep: 1, lines: 1 }
    })
    await run.advance(59 * MIN)
    expect(run.sent).toHaveLength(1)
    await run.advance(MIN)
    expect(run.lines()).toEqual([
      '02:39 Still working on this (30 min).',
      '03:55 Still working on this (1 h 46 min).'
    ])
    expect(run.sent[1]?.replyId).toBe(statusReplyId(THREAD, START, 2))
  })

  it('counts a saved line read back after a restart or from an older Orca', async () => {
    // The cloud takes the line, but the app quits before its answer comes back.
    const store = botHome()
    const before = harness(store, {
      cloud: () => ({ cloudFeatures: () => new Set<string>(), reply: () => new Promise(() => {}) })
    })
    await before.turnEnded()
    await before.advance(30 * MIN)
    expect(before.fact()?.pending?.replyId).toBe(statusReplyId(THREAD, START, 1))
    await store.flushPendingOrThrowAsync()
    await closeTestStores()

    const after = harness(createStore())
    after.clock.now = START + 41 * MIN
    after.status.watched()
    await after.polled()
    expect(after.sent).toHaveLength(0)
    expect(after.fact()).toMatchObject({
      seq: 1,
      dayCount: 1,
      armed: { lastLineAt: START + 41 * MIN, dueStep: 1 }
    })
    await after.advance(60 * MIN)
    expect(after.lines()).toEqual(['03:50 Still working on this (1 h 41 min).'])
    await closeTestStores()

    // A line an older Orca saved and may have sent; nothing on it says whether it went.
    const older = botHome()
    writeLinkFact(older, THREAD, {
      threadStatus: {
        seq: 1,
        day: '2026-11-26',
        dayCount: 0,
        armed: { at: START, turnEndAt: START, lastLineAt: START, lastBotAt: 0, dueStep: 0 },
        pending: {
          replyId: statusReplyId(THREAD, START, 1),
          text: 'Still working on this (30 min).',
          at: START + 30 * MIN,
          stop: false
        }
      }
    })
    const upgraded = harness(older)
    upgraded.clock.now = START + 41 * MIN
    upgraded.status.watched()
    await upgraded.polled()
    expect(upgraded.sent).toHaveLength(0)
    expect(upgraded.fact()).toMatchObject({ seq: 1, dayCount: 1, armed: { dueStep: 1 } })
  })

  it('ends the run on a dropped stop line that went out with no answer, and starts the next clean', async () => {
    const conflict = { ok: false as const, status: 409, error: 'reply_id_conflict' }
    const noAnswer = { ok: false as const, status: null, error: null }
    const run = harness(botHome(), { answers: [{ ok: true }, conflict, noAnswer, conflict] })
    await run.turnEnded()
    await run.advance(30 * MIN)
    // The workers read cap closes them: the stop line conflicts once, then gets no answer, and a
    // turn holds its retry past 10 minutes.
    await run.polled(view({ activity: 'idle', open: false }))
    await run.advance(MIN)
    expect(run.sent.map((body) => body.text).slice(1)).toEqual([
      THREAD_STATUS_STOP_LINE,
      THREAD_STATUS_STOP_LINE
    ])
    run.clock.running = run.clock.now
    await run.advance(15 * MIN)
    run.clock.running = null
    await run.advance(MIN)
    expect(run.sent).toHaveLength(3)
    expect(run.fact()).toEqual({ seq: 3, day: '2026-11-26', dayCount: 2 })
    // A new run's first conflict only drops its line: the old run's conflict is forgotten.
    await run.turnEnded()
    await run.advance(31 * MIN)
    expect(run.sent).toHaveLength(5)
    expect(run.fact()?.armed?.lines).toBe(1)
  })

  it('still posts the stop line when the first update went out with no answer', async () => {
    // The first update may be in the thread; the workers read cap closes them before it settles.
    const noAnswer = { ok: false as const, status: null, error: null }
    const run = harness(botHome(), { answers: [noAnswer] })
    await run.turnEnded()
    await run.advance(30 * MIN)
    await run.polled(view({ activity: 'idle', open: false }))
    expect(run.fact()?.armed?.lines).toBe(1)
    await run.advance(MIN)
    expect(run.lines()).toEqual([
      '02:39 Still working on this (30 min).',
      `02:40 ${THREAD_STATUS_STOP_LINE}`
    ])
    expect(run.fact()).toEqual({ seq: 2, day: '2026-11-26', dayCount: 2 })

    // An update this process saved and never sent is known absent: the run ends quietly.
    const unsaved = botHome(DM)
    const quiet = harness(unsaved, {
      flush: () => Promise.reject(new Error('disk full'))
    })
    quiet.status.turnEnding(PANE)
    quiet.status.applied(PANE, view(), new Set(['turn-ended']))
    await quiet.advance(30 * MIN)
    expect(findLink(unsaved, DM)?.link.threadStatus?.pending).toBeDefined()
    await quiet.polled(view({ activity: 'idle', open: false }))
    expect(quiet.sent).toHaveLength(0)
    expect(findLink(unsaved, DM)?.link.threadStatus).toEqual({
      seq: 1,
      day: '2026-11-26',
      dayCount: 0
    })
  })

  it('counts for the day a line that went out with no answer when its run stops quietly', async () => {
    // Muted while the update's answer never came: it may be in the thread, so the day keeps it.
    const noAnswer = { ok: false as const, status: null, error: null }
    const store = botHome()
    const run = harness(store, { answers: [noAnswer] })
    await run.turnEnded()
    await run.advance(30 * MIN)
    expect(run.fact()?.pending).toBeDefined()
    writeLinkFact(store, THREAD, { muted: true, leaveLine: 9 })
    await run.advance(MIN)
    expect(run.sent).toHaveLength(1)
    expect(run.fact()).toEqual({ seq: 1, day: '2026-11-26', dayCount: 1 })

    // A line the cloud refused is known absent: its run stops without counting it.
    const refused = botHome(DM)
    const never = harness(refused, { answers: [{ ok: false, status: 403, error: null }] })
    never.status.turnEnding(PANE)
    never.status.applied(PANE, view(), new Set(['turn-ended']))
    await never.advance(30 * MIN)
    expect(never.sent).toHaveLength(1)
    expect(findLink(refused, DM)?.link.threadStatus).toEqual({
      seq: 1,
      day: '2026-11-26',
      dayCount: 0
    })
  })

  it('counts a line refused or in conflict on a retry after a try that got no answer', async () => {
    // The first try may have posted it; the refusal speaks only for the retry.
    const noAnswer = { ok: false as const, status: null, error: null }
    const run = harness(botHome(), { answers: [noAnswer, { ok: false, status: 403, error: null }] })
    await run.turnEnded()
    await run.advance(31 * MIN)
    expect(run.sent.map((body) => body.replyId)).toEqual([
      statusReplyId(THREAD, START, 1),
      statusReplyId(THREAD, START, 1)
    ])
    expect(run.fact()).toEqual({ seq: 1, day: '2026-11-26', dayCount: 1 })
    await closeTestStores()

    // A conflict on the retry drops the line as one that may have posted: the backoff holds.
    const conflict = { ok: false as const, status: 409, error: 'reply_id_conflict' }
    const again = harness(botHome(), { answers: [noAnswer, conflict] })
    await again.turnEnded()
    await again.advance(31 * MIN)
    expect(again.fact()).toMatchObject({
      dayCount: 1,
      armed: { lastLineAt: START + 31 * MIN, dueStep: 1, lines: 1 }
    })
    await again.advance(59 * MIN)
    expect(again.sent).toHaveLength(2)
    await again.advance(MIN)
    expect(again.lines().at(-1)).toBe('03:40 Still working on this (1 h 31 min).')
  })

  it('keeps a never-sent line uncounted when the save of the line after it fails', async () => {
    const store = botHome()
    const save = store.updateFolderWorkspace.bind(store)
    let failing = false
    store.updateFolderWorkspace = (...args: Parameters<typeof save>) => {
      if (failing) {
        throw new Error('disk full')
      }
      return save(...args)
    }
    // Never on disk in time, so never sent: the line is known absent from the thread.
    let flushed = false
    const run = harness(store, {
      flush: () => (flushed ? Promise.resolve() : Promise.reject(new Error('not yet')))
    })
    await run.turnEnded()
    await run.advance(30 * MIN)
    const first = run.fact()?.pending?.replyId
    expect(first).toBe(statusReplyId(THREAD, START, 1))
    // Stale at 41 min: its drop and the next line's save both fail, so it stays on the link.
    failing = true
    await run.advance(11 * MIN)
    expect(run.fact()?.pending?.replyId).toBe(first)
    failing = false
    flushed = true
    await run.advance(MIN)
    // Dropped uncounted, and the next line goes as the first of the run.
    expect(run.fact()?.dayCount).toBe(1)
    expect(run.lines()).toEqual(['02:51 Still working on this (42 min).'])
    expect(run.fact()?.armed).toMatchObject({ dueStep: 1, lines: 1 })
  })

  it('sends a saved line again only while a new one could go, and counts it once dropped', async () => {
    const busy = { ok: false as const, status: 503, error: null, retryAfterMs: 5 * MIN }
    const run = harness(botHome(), { answers: [busy] })
    await run.turnEnded()
    await run.advance(30 * MIN)
    // A person asks at 0:32; the retry falls inside the turn and waits for it.
    run.clock.running = START + 32 * MIN
    await run.advance(20 * MIN)
    expect(run.sent).toHaveLength(1)
    // The turn's answer makes the saved line moot. It may still have posted before the answer, so
    // once dropped it counts, and the next line waits the longer backoff from then.
    run.clock.running = null
    await run.turnEnded()
    run.botSaid()
    await run.advance(30 * MIN)
    expect(run.sent).toHaveLength(1)
    expect(run.fact()).toMatchObject({ dayCount: 1, armed: { lastLineAt: run.clock.now } })
    await run.advance(59 * MIN)
    expect(run.sent).toHaveLength(1)
    await run.advance(MIN)
    expect(run.sent.map((body) => body.replyId)).toEqual([
      statusReplyId(THREAD, START, 1),
      statusReplyId(THREAD, START, 2)
    ])
    await closeTestStores()

    const settled = harness(botHome(), { answers: [busy] })
    await settled.turnEnded()
    await settled.advance(30 * MIN)
    await settled.polled(view({ activity: 'none', open: false }))
    await settled.advance(10 * MIN)
    expect(settled.sent).toHaveLength(1)
    expect(settled.fact()?.armed).toBeUndefined()
  })
})
