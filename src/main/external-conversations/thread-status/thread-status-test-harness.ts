// The fake clock, cloud and store the ThreadStatus tests share.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach } from 'vitest'
import type { ExternalConversationLink } from '../../../shared/connectors/external-conversation-link'
import { folderWorkspaceKey } from '../../../shared/workspace/identity/workspace-scope'
import type { ConnectorReplyBody } from '../../connector-cloud/connector-replies'
import { closeTestStores, createStore, testState } from '../../persistence/persistence-test-harness'
import { findLink, writeLink } from '../external-conversation-links'
import type { ConversationWorkerView } from '../external-conversation-workers'
import { ThreadStatus, type ThreadStatusDeps } from './thread-status'

export const MIN = 60_000
export const HOUR = 60 * MIN
// The incident: "building A now" at 02:09Z, then a worker in review rounds for hours.
export const START = Date.UTC(2026, 10, 26, 2, 9)
export const THREAD = { source: 'slack' as const, externalId: 'T1:C1:1795657346.281449:U0BOT' }
export const DM = { source: 'slack' as const, externalId: 'T1:D1:D1:U0BOT' }
export const PANE = 'pane-thread'

export type Answer =
  | { ok: true }
  | { ok: false; status: number | null; error: string | null; retryAfterMs?: number }

/** Each test gets its own store folder. */
export function setUpThreadStatusDirs(): void {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-thread-status-'))
  })
  afterEach(async () => {
    await closeTestStores()
    rmSync(testState.dir, { recursive: true, force: true })
  })
}

export function botHome(
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

export function deferred<T = void>() {
  let release!: (value: T) => void
  const promise = new Promise<T>((resolve) => (release = resolve))
  return { promise, release }
}

export const view = (extra: Partial<ConversationWorkerView> = {}): ConversationWorkerView => ({
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
export function harness(
  store: ReturnType<typeof createStore>,
  options: Partial<ThreadStatusDeps> & {
    answers?: Answer[]
    features?: boolean
    turnEndPending?: () => boolean
  } = {}
) {
  const clock: { now: number; running: number | null } = { now: START, running: null }
  const timers: { at: number; run: () => void }[] = []
  const sent: (ConnectorReplyBody & { at: number })[] = []
  const answers = options.answers ?? []
  const cloud = {
    cloudFeatures: () => (options.features === false ? null : new Set<string>()),
    turnEndPending: options.turnEndPending ?? (() => false),
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
  /** A turn ends, as the app tells it: at once, then its workers read once its answer is read. */
  const turnEnded = async (read = view()) => {
    status.turnEnding(PANE)
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
  return {
    timers: () => timers.length,
    status,
    clock,
    sent,
    lines,
    advance,
    settle,
    turnEnded,
    polled,
    botSaid,
    fact
  }
}
