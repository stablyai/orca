import { describe, expect, it } from 'vitest'
import { closeTestStores, createStore } from '../../persistence/persistence-test-harness'
import { findLink, removeLink, writeLink } from '../external-conversation-links'
import { writeLinkFact } from '../external-conversation-link-writes'
import { THREAD_STATUS_STOP_LINE } from './thread-status-decide'
import { statusReplyId } from './thread-status-fact'
import {
  botHome,
  deferred,
  DM,
  harness,
  HOUR,
  MIN,
  PANE,
  START,
  THREAD,
  setUpThreadStatusDirs,
  view
} from './thread-status-test-harness'

setUpThreadStatusDirs()

describe('ThreadStatus', () => {
  it('replays the silent-thread incident as four heartbeats and a stop line', async () => {
    const run = harness(botHome())
    await run.turnEnded()
    // The turn's own answer ("building A now") reaches the thread as it ends.
    run.botSaid()
    await run.advance(6 * HOUR + 30 * MIN)
    expect(run.lines()).toEqual([
      '02:39 Still working on this (30 min).',
      '03:39 Still working on this (1 h 30 min).',
      '05:39 Still working on this (3 h 30 min).',
      '07:39 Still working on this (5 h 30 min).',
      `08:09 ${THREAD_STATUS_STOP_LINE}`
    ])
    expect(run.fact()).toEqual({ seq: 5, day: '2026-11-26', dayCount: 5 })
    // Each line went as Orca's own, on no one's behalf, under its saved id and time.
    expect(run.sent[0]).toMatchObject({
      conversation: THREAD,
      replyId: statusReplyId(THREAD, START, 1),
      turnFor: 'none',
      turnId: START + 30 * MIN
    })
  })

  it("stops quietly once the work settles, and a bot line restarts the thread's clock", async () => {
    const run = harness(botHome())
    await run.turnEnded()
    await run.advance(50 * MIN)
    run.botSaid()
    await run.advance(29 * MIN)
    expect(run.lines()).toEqual(['02:39 Still working on this (30 min).'])
    await run.advance(MIN)
    expect(run.lines()).toHaveLength(2)
    await run.polled(view({ activity: 'none', open: false }))
    await run.advance(4 * HOUR)
    expect(run.sent).toHaveLength(2)
    expect(run.fact()?.armed).toBeUndefined()
  })

  it('arms only a Slack bot thread or DM with open workers after a heard turn end', async () => {
    const quiet = harness(botHome())
    await quiet.turnEnded(view({ activity: 'none', open: false }))
    await quiet.polled()
    expect(quiet.fact()).toBeUndefined()
    await closeTestStores()

    const home = harness(botHome(THREAD, { kind: 'bot-chat', botId: 'bot-1' }))
    await home.turnEnded()
    expect(home.fact()).toBeUndefined()
    await closeTestStores()

    const dmStore = botHome(DM)
    const dm = harness(dmStore)
    await dm.turnEnded()
    expect(findLink(dmStore, DM)?.link.threadStatus?.armed).toBeDefined()
  })

  it('says nothing is running for an idle worker, and stops at the workers read cap', async () => {
    const run = harness(botHome())
    await run.turnEnded(view({ activity: 'idle' }))
    await run.advance(30 * MIN)
    expect(run.lines()).toEqual([
      '02:39 Still open (30 min), but nothing is running on it right now. Reply here to ask where it stands.'
    ])
    await run.polled(view({ activity: 'idle', open: false }))
    expect(run.lines()[1]).toBe(`02:39 ${THREAD_STATUS_STOP_LINE}`)
    expect(run.fact()?.armed).toBeUndefined()
  })

  it('holds a line while a turn runs, unless it ran past 30 minutes with no open prompt', async () => {
    const run = harness(botHome())
    await run.turnEnded()
    run.clock.running = START + 25 * MIN
    await run.advance(30 * MIN)
    expect(run.sent).toHaveLength(0)
    run.status.observed(
      '/v1/connector/events',
      { v: 1, events: [{ kind: 'prompt', conversation: THREAD, prompt: { promptId: 'p1' } }] },
      { ok: true }
    )
    await run.advance(90 * MIN)
    expect(run.sent).toHaveLength(0)
    run.status.observed(
      '/v1/connector/events',
      {
        v: 1,
        events: [
          { kind: 'prompt', conversation: THREAD, prompt: { promptId: 'p1' }, answered: true }
        ]
      },
      { ok: true }
    )
    await run.advance(30 * MIN)
    expect(run.sent).toHaveLength(1)
  })

  it("holds a line behind the turn's unsent answer, a read that fails, and a held mirror post", async () => {
    let unsent: Promise<boolean> = Promise.resolve(true)
    const store = botHome()
    const run = harness(store, { answerPending: () => unsent })
    await run.turnEnded()
    await run.advance(31 * MIN)
    unsent = Promise.reject(new Error('journal closed'))
    await run.advance(MIN)
    expect(run.sent).toHaveLength(0)
    unsent = Promise.resolve(false)
    await run.advance(MIN)
    expect(run.sent).toHaveLength(1)
    await closeTestStores()

    const mirrored = botHome()
    const held = harness(mirrored)
    await held.turnEnded()
    const link = findLink(mirrored, THREAD)!.link
    writeLink(mirrored, findLink(mirrored, THREAD)!.workspace, {
      ...link,
      mirrorHeld: [{ event: { kind: 'turn-ended', turnId: 7 }, waiting: ['item-1'] }]
    })
    await held.advance(45 * MIN)
    expect(held.sent).toHaveLength(0)
  })

  it('sends a line saved before a quit again under the same id and words', async () => {
    const store = botHome()
    // The app quits while the cloud still hasn't answered the line.
    const before = harness(store, {
      cloud: () => ({ cloudFeatures: () => new Set<string>(), reply: () => new Promise(() => {}) })
    })
    await before.turnEnded()
    await before.advance(30 * MIN)
    const pending = before.fact()?.pending
    expect(pending).toMatchObject({ replyId: statusReplyId(THREAD, START, 1), stop: false })
    await store.flushPendingOrThrowAsync()
    await closeTestStores()

    const reopened = createStore()
    const after = harness(reopened)
    after.clock.now = pending!.at + 5 * MIN
    after.status.watched()
    await after.settle()
    // Nothing goes before the watch's first read says the work still runs.
    expect(after.sent).toHaveLength(0)
    await after.polled()
    expect(after.sent).toEqual([
      expect.objectContaining({
        replyId: pending!.replyId,
        text: pending!.text,
        turnId: pending!.at
      })
    ])
    expect(after.fact()).toMatchObject({ seq: 1, dayCount: 1 })
  })

  it('posts one line, not the missed ones, after the computer slept for 3 hours', async () => {
    const run = harness(botHome())
    await run.turnEnded()
    run.clock.now += 3 * HOUR
    await run.advance(MIN)
    expect(run.lines()).toEqual(['05:10 Still working on this (3 h 1 min).'])
  })

  it('retries a busy cloud with the same line, drops a conflict, and stops on a refusal', async () => {
    const busy = harness(botHome(), { answers: [{ ok: false, status: 429, error: null }] })
    await busy.turnEnded()
    await busy.advance(31 * MIN)
    expect(busy.sent.map((body) => body.replyId)).toEqual([
      statusReplyId(THREAD, START, 1),
      statusReplyId(THREAD, START, 1)
    ])
    await closeTestStores()

    const conflict = { ok: false as const, status: 409, error: 'reply_id_conflict' }
    const twice = harness(botHome(), { answers: [conflict, conflict] })
    await twice.turnEnded()
    await twice.advance(32 * MIN)
    expect(twice.sent.map((body) => body.replyId)).toEqual([
      statusReplyId(THREAD, START, 1),
      statusReplyId(THREAD, START, 2)
    ])
    expect(twice.fact()?.armed).toBeUndefined()
    await closeTestStores()

    const refused = harness(botHome(), {
      answers: [{ ok: false, status: 403, error: 'not_this_hosts_thread' }]
    })
    await refused.turnEnded()
    await refused.advance(3 * HOUR)
    expect(refused.sent).toHaveLength(1)
    expect(refused.fact()).toEqual({ seq: 1, day: '2026-11-26', dayCount: 0 })
  })

  it('waits for the cloud hello and for the first read after a reconnect', async () => {
    const run = harness(botHome(), { features: false })
    await run.turnEnded()
    await run.advance(45 * MIN)
    expect(run.sent).toHaveLength(0)
    await closeTestStores()

    const cleared = harness(botHome())
    await cleared.turnEnded()
    cleared.status.cleared()
    await cleared.advance(45 * MIN)
    expect(cleared.sent).toHaveLength(0)
    await cleared.polled()
    expect(cleared.sent).toHaveLength(1)
  })

  it('stops quietly once the thread is muted', async () => {
    const store = botHome()
    const run = harness(store)
    await run.turnEnded()
    writeLinkFact(store, THREAD, { muted: true, leaveLine: 9 })
    await run.advance(45 * MIN)
    expect(run.sent).toHaveLength(0)
    expect(run.fact()?.armed).toBeUndefined()
  })

  it('starts no run once the day has no room left for an update and a stop line', async () => {
    const store = botHome()
    writeLinkFact(store, THREAD, { threadStatus: { seq: 12, day: '2026-11-26', dayCount: 11 } })
    const run = harness(store)
    for (let i = 0; i < 3; i++) {
      await run.turnEnded()
      await run.advance(5 * MIN)
    }
    expect(run.sent).toHaveLength(0)
    expect(run.fact()).toEqual({ seq: 12, day: '2026-11-26', dayCount: 11 })
  })

  it('never reuses a reply id when a dropped link starts the numbering over', async () => {
    const store = botHome()
    const run = harness(store)
    await run.turnEnded()
    await run.advance(30 * MIN)
    const { workspace } = findLink(store, THREAD)!
    removeLink(store, THREAD)
    writeLink(store, workspace, {
      ...THREAD,
      sessionId: 'chat-2',
      agent: 'claude',
      paneKey: PANE,
      bot: { kind: 'bot', botId: 'bot-1' },
      createdAt: 2
    })
    await run.turnEnded()
    await run.advance(30 * MIN)
    const [first, second] = run.sent
    expect(first?.text).toBe(second?.text)
    expect(first?.replyId).not.toBe(second?.replyId)
  })

  it('never posts a due line beside the answer of the turn that just ended', async () => {
    const run = harness(botHome())
    await run.turnEnded()
    await run.advance(30 * MIN)
    // A person asks at 1:20 and the turn runs past the next line's time.
    run.clock.running = START + 80 * MIN
    await run.advance(65 * MIN)
    expect(run.sent).toHaveLength(1)
    // It ends at 3:44; its answer is read and posted, and its workers read, a minute later.
    run.clock.running = null
    run.status.turnEnding(PANE)
    await run.advance(MIN)
    expect(run.sent).toHaveLength(1)
    run.botSaid()
    run.status.applied(PANE, view(), new Set(['turn-ended']))
    await run.advance(29 * MIN)
    expect(run.sent).toHaveLength(1)
    await run.advance(MIN)
    expect(run.lines()[1]).toBe('04:15 Still working on this (2 h 6 min).')
  })

  it('keeps the backoff through turn ends that put nothing in the thread', async () => {
    const run = harness(botHome())
    await run.turnEnded()
    // Worker reports wake the bot every 20 minutes, and it answers each in Orca only.
    for (let minute = 20; minute <= 6 * 60; minute += 20) {
      await run.advance(20 * MIN)
      await run.turnEnded()
    }
    expect(run.lines()).toEqual([
      '02:39 Still working on this (30 min).',
      '03:39 Still working on this (1 h 30 min).',
      '05:39 Still working on this (3 h 30 min).',
      '07:39 Still working on this (5 h 30 min).'
    ])
  })

  it('posts nothing that changed while its save or answer read was waiting', async () => {
    type Run = ReturnType<typeof harness>
    // What changes during the save, and what becomes of the saved line: kept for later, dropped,
    // or its run stopped at once.
    const changes: [(run: Run) => void | Promise<void>, 'kept' | 'dropped' | 'disarmed'][] = [
      [(run) => void (run.clock.running = run.clock.now), 'kept'],
      [(run) => run.status.turnEnding(PANE), 'kept'],
      [(run) => run.botSaid(), 'dropped'],
      [(run) => run.polled(view({ activity: 'none', open: false })), 'disarmed']
    ]
    for (const [change, becomes] of changes) {
      const save = deferred()
      const run = harness(botHome(), { flush: () => save.promise })
      await run.turnEnded()
      await run.advance(30 * MIN)
      expect(run.fact()?.pending).toBeDefined()
      await change(run)
      save.release()
      await run.settle()
      expect(run.sent).toHaveLength(0)
      expect(
        {
          kept: run.fact()?.pending !== undefined,
          dropped: !!run.fact()?.armed && run.fact()?.pending === undefined,
          disarmed: run.fact()?.armed === undefined
        }[becomes]
      ).toBe(true)
      await closeTestStores()
    }

    const read = deferred<boolean>()
    const answering = harness(botHome(), { answerPending: () => read.promise })
    await answering.turnEnded()
    await answering.advance(30 * MIN)
    answering.clock.running = answering.clock.now
    read.release(false)
    await answering.settle()
    expect(answering.sent).toHaveLength(0)
    expect(answering.fact()?.pending).toBeUndefined()
    await closeTestStores()

    // An owner's mirror post fails during the read: the link as it is now holds the line.
    const mirrorRead = deferred<boolean>()
    const mirrored = botHome()
    const held = harness(mirrored, { answerPending: () => mirrorRead.promise })
    await held.turnEnded()
    await held.advance(30 * MIN)
    const { link, workspace } = findLink(mirrored, THREAD)!
    writeLink(mirrored, workspace, {
      ...link,
      mirrorHeld: [{ event: { kind: 'turn-ended', turnId: 7 }, waiting: ['item-1'] }]
    })
    mirrorRead.release(false)
    await held.settle()
    expect(held.sent).toHaveLength(0)
    expect(held.fact()?.pending).toBeUndefined()
  })

  it('replaces a saved update the workers no longer bear out, and waits out a lost hello', async () => {
    const save = deferred()
    const run = harness(botHome(), { flush: () => save.promise })
    await run.turnEnded()
    await run.advance(30 * MIN)
    // The worker goes idle while "still working" waits on its save.
    await run.polled(view({ activity: 'idle' }))
    save.release()
    await run.settle()
    expect(run.sent.map(({ replyId, text }) => [replyId, text.slice(0, 10)])).toEqual([
      [statusReplyId(THREAD, START, 2), 'Still open']
    ])
    await closeTestStores()

    const hello = deferred()
    const options = { flush: () => hello.promise, features: true }
    const offline = harness(botHome(), options)
    await offline.turnEnded()
    await offline.advance(30 * MIN)
    options.features = false
    hello.release()
    await offline.settle()
    expect(offline.sent).toHaveLength(0)
    options.features = true
    await offline.advance(MIN)
    expect(offline.sent.map((body) => body.replyId)).toEqual([statusReplyId(THREAD, START, 1)])
  })

  it('never posts a saved stop line beside a bot line of the same moment', async () => {
    const save = deferred()
    let paused = false
    const run = harness(botHome(), { flush: () => (paused ? save.promise : Promise.resolve()) })
    await run.turnEnded()
    await run.advance(30 * MIN)
    expect(run.sent).toHaveLength(1)
    paused = true
    await run.polled(view({ activity: 'idle', open: false }))
    expect(run.fact()?.pending?.stop).toBe(true)
    run.botSaid()
    save.release()
    await run.settle()
    expect(run.sent).toHaveLength(1)
    expect(run.fact()?.pending).toBeUndefined()
  })

  it("waits for a later turn's unsent answer that ended while a read or save was waiting", async () => {
    for (const waitsOn of ['read', 'save'] as const) {
      const earlier = deferred<boolean>()
      const save = deferred()
      let laterUnsent = true
      const store = botHome()
      const run = harness(store, {
        answerPending: (_link, turnId) =>
          turnId === 8
            ? Promise.resolve(laterUnsent)
            : waitsOn === 'read'
              ? earlier.promise
              : Promise.resolve(false),
        flush: () => (waitsOn === 'save' ? save.promise : Promise.resolve())
      })
      await run.turnEnded()
      await run.advance(30 * MIN)
      // Turn 8 ends meanwhile; its answer is still in the outbox once its settle window passes.
      await run.turnEnded(view({ lastTurnId: 8 }))
      await run.advance(3 * MIN)
      earlier.release(false)
      save.release()
      await run.advance(2 * MIN)
      expect(run.sent).toHaveLength(0)
      laterUnsent = false
      await run.advance(MIN)
      expect(run.sent).toHaveLength(1)
      await closeTestStores()
    }
  })

  it('stops retrying a line once a turn starts during the backoff', async () => {
    const tries: number[] = []
    const store = botHome()
    const run = harness(store, {
      cloud: () => ({
        cloudFeatures: () => new Set<string>(),
        reply: (_body, proceed) => {
          tries.push(run.clock.now)
          // Busy; a person asks during the backoff, before the transport's next try.
          run.clock.running = run.clock.now
          if (proceed?.()) {
            tries.push(run.clock.now)
          }
          return Promise.resolve({ ok: false, status: 503, error: null })
        }
      })
    })
    await run.turnEnded()
    await run.advance(30 * MIN)
    expect(tries).toHaveLength(1)
  })

  it("starts a run's conflicts over: one 409 in a new run never stops it", async () => {
    const conflict = { ok: false as const, status: 409, error: 'reply_id_conflict' }
    const run = harness(botHome(), { answers: [conflict, conflict] })
    await run.turnEnded()
    await run.advance(30 * MIN)
    await run.polled(view({ activity: 'none', open: false }))
    expect(run.fact()?.armed).toBeUndefined()
    await run.turnEnded()
    await run.advance(31 * MIN)
    expect(run.sent).toHaveLength(3)
    expect(run.fact()?.armed?.lines).toBe(1)
  })

  it("waits out the cloud's Retry-After before sending the same line again", async () => {
    const run = harness(botHome(), {
      answers: [{ ok: false, status: 429, error: null, retryAfterMs: 5 * MIN }]
    })
    await run.turnEnded()
    await run.advance(34 * MIN)
    expect(run.sent).toHaveLength(1)
    await run.advance(MIN)
    expect(run.sent.map((body) => body.replyId)).toEqual([
      statusReplyId(THREAD, START, 1),
      statusReplyId(THREAD, START, 1)
    ])
  })

  it('holds a line until it is on disk and while the cloud still queues the turn end', async () => {
    let saves = 0
    const unsaved = harness(botHome(), {
      flush: async () => {
        saves += 1
        if (saves === 1) {
          throw new Error('disk busy')
        }
      }
    })
    await unsaved.turnEnded()
    await unsaved.advance(30 * MIN)
    expect(unsaved.sent).toHaveLength(0)
    await unsaved.advance(MIN)
    expect(unsaved.sent.map((body) => body.replyId)).toEqual([statusReplyId(THREAD, START, 1)])
    await closeTestStores()

    let queued = true
    const ending = harness(botHome(), { turnEndPending: () => queued })
    await ending.turnEnded()
    await ending.advance(45 * MIN)
    expect(ending.sent).toHaveLength(0)
    queued = false
    await ending.advance(MIN)
    expect(ending.sent).toHaveLength(1)
  })

  it('ends a run that can no longer read its workers, and its clock with it', async () => {
    const run = harness(botHome())
    await run.turnEnded()
    run.status.cleared()
    await run.advance(9 * HOUR)
    expect(run.sent).toHaveLength(0)
    expect(run.fact()?.armed).toBeUndefined()
    expect(run.timers()).toBe(0)
  })
})
