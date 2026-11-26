import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ExternalConversationLink } from '../../../shared/connectors/external-conversation-link'
import { folderWorkspaceKey } from '../../../shared/workspace/identity/workspace-scope'
import type { ConnectorReplyBody } from '../../connector-cloud/connector-replies'
import { closeTestStores, createStore, testState } from '../../persistence/persistence-test-harness'
import { findLink, writeLink } from '../external-conversation-links'
import { writeLinkFact } from '../external-conversation-link-writes'
import type { ConversationWorkerView } from '../external-conversation-workers'
import { THREAD_STATUS_STOP_LINE } from './thread-status-decide'
import { ThreadStatus, type ThreadStatusDeps } from './thread-status'
import { statusReplyId } from './thread-status-fact'

const MIN = 60_000
const HOUR = 60 * MIN
// The incident: "building A now" at 02:09Z, then a worker in review rounds for hours.
const START = Date.UTC(2026, 10, 26, 2, 9)
const THREAD = { source: 'slack' as const, externalId: 'T1:C1:1795657346.281449:U0BOT' }
const DM = { source: 'slack' as const, externalId: 'T1:D1:D1:U0BOT' }
const PANE = 'pane-thread'

type Answer = { ok: true } | { ok: false; status: number | null; error: string | null }

beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'orca-thread-status-'))
})

afterEach(async () => {
  await closeTestStores()
  rmSync(testState.dir, { recursive: true, force: true })
})

function botHome(
  key: { source: 'slack'; externalId: string } = THREAD,
  bot: ExternalConversationLink['bot'] = { kind: 'bot', botId: 'bot-1' }
) {
  const store = createStore()
  const group = store.createProjectGroup({
    name: 'Bots',
    parentPath: testState.dir,
    connectionId: null,
    parentGroupId: null,
    createdFrom: 'manual'
  })
  const folder = store.createFolderWorkspace({
    projectGroupId: group.id,
    folderPath: testState.dir
  })
  writeLink(
    store,
    { worktreeId: folderWorkspaceKey(folder.id), sshHostId: null },
    { ...key, sessionId: 'chat-1', agent: 'claude', paneKey: PANE, bot, createdAt: 1 }
  )
  return store
}

const view = (extra: Partial<ConversationWorkerView> = {}): ConversationWorkerView => ({
  activity: 'working',
  open: true,
  helpersRunning: false,
  since: START,
  unverifiableSince: null,
  lastTurnId: 7,
  ...extra
})

/** Orca's status lines over a fake clock and cloud; every reply the cloud takes is observed, as
 *  the transport observes it. */
function harness(
  store: ReturnType<typeof createStore>,
  options: Partial<ThreadStatusDeps> & { answers?: Answer[]; features?: boolean } = {}
) {
  const clock = { now: START, running: null as number | null }
  const timers: { at: number; run: () => void }[] = []
  const sent: (ConnectorReplyBody & { at: number })[] = []
  const answers = options.answers ?? []
  const cloud = {
    cloudFeatures: () => (options.features === false ? null : new Set<string>()),
    turnEndPending: () => false,
    reply: (body: ConnectorReplyBody) => {
      sent.push({ ...body, at: clock.now })
      const answer = answers.shift() ?? { ok: true as const }
      if (answer.ok) {
        status.observed('/v1/connector/replies', { v: 1, ...body }, { ok: true, value: {} })
      }
      return Promise.resolve(answer)
    }
  }
  const status = new ThreadStatus({
    store,
    cloud: () => cloud,
    flush: async () => {},
    runningTurn: () => clock.running,
    now: () => clock.now,
    setTick: (run, ms) => {
      const timer = { at: clock.now + ms, run }
      timers.push(timer)
      return { cancel: () => timers.splice(timers.indexOf(timer), 1) }
    },
    ...options
  })
  const settle = async () => {
    for (let i = 0; i < 5; i++) {
      await new Promise((resolve) => setImmediate(resolve))
    }
  }
  /** Moves the clock a minute at a time, firing due ticks. */
  const advance = async (ms: number) => {
    const until = clock.now + ms
    while (clock.now < until) {
      clock.now = Math.min(clock.now + MIN, until)
      for (const timer of timers.filter((candidate) => candidate.at <= clock.now)) {
        timers.splice(timers.indexOf(timer), 1)
        timer.run()
      }
      await settle()
    }
  }
  const turnEnded = async (read = view()) => {
    status.applied(PANE, read, new Set(['turn-ended']))
    await settle()
  }
  const polled = async (read = view()) => {
    status.applied(PANE, read, new Set(['poll']))
    await settle()
  }
  const botSaid = () =>
    status.observed(
      '/v1/connector/events',
      { v: 1, events: [{ kind: 'reply', conversation: THREAD, outcome: 'answered' }] },
      { ok: true }
    )
  const lines = () =>
    sent.map(({ at, text }) => `${new Date(at).toISOString().slice(11, 16)} ${text}`)
  const fact = () => findLink(store, THREAD)?.link.threadStatus
  return { status, clock, sent, lines, advance, settle, turnEnded, polled, botSaid, fact }
}

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
      replyId: statusReplyId(THREAD, 1),
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
    expect(pending).toMatchObject({ replyId: statusReplyId(THREAD, 1), stop: false })
    await store.flushPendingOrThrowAsync()
    await closeTestStores()

    const reopened = createStore()
    const after = harness(reopened)
    after.clock.now = pending!.at + 5 * MIN
    after.status.watched()
    await after.settle()
    expect(after.sent).toEqual([
      expect.objectContaining({
        replyId: pending!.replyId,
        text: pending!.text,
        turnId: pending!.at
      })
    ])
    expect(after.fact()).toMatchObject({ seq: 1, dayCount: 1 })
  })

  it('drops a saved line older than 10 minutes and decides afresh under the next id', async () => {
    const store = botHome()
    const run = harness(store, { answers: [{ ok: false, status: 503, error: null }] })
    await run.turnEnded()
    await run.advance(30 * MIN)
    expect(run.fact()?.pending?.replyId).toBe(statusReplyId(THREAD, 1))
    run.clock.now += 11 * MIN
    run.status.watched()
    await run.settle()
    expect(run.sent.map((body) => body.replyId)).toEqual([
      statusReplyId(THREAD, 1),
      statusReplyId(THREAD, 2)
    ])
    expect(run.sent[1]?.text).toBe('Still working on this (41 min).')
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
      statusReplyId(THREAD, 1),
      statusReplyId(THREAD, 1)
    ])
    await closeTestStores()

    const conflict = { ok: false as const, status: 409, error: 'reply_id_conflict' }
    const twice = harness(botHome(), { answers: [conflict, conflict] })
    await twice.turnEnded()
    await twice.advance(32 * MIN)
    expect(twice.sent.map((body) => body.replyId)).toEqual([
      statusReplyId(THREAD, 1),
      statusReplyId(THREAD, 2)
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
})
