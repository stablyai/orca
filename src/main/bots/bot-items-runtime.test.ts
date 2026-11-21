import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BotChangeScope } from '../../shared/bots/bot-change-scope'
import type { BotWorkWorker } from './bot-work-types'
import { BotItemsHost, type BotItemsHostDeps } from './bot-items-runtime'
import type { BotItemAddInput, BotItemBotActor } from './bot-items-input'
import { BotsDbWorkerClient } from './db-worker/bots-db-worker-client'
import { closeBotsDbStores } from './db-worker/bots-db-worker-entry'
import { inProcessBotsDbWorker } from './db-worker/bots-db-worker.test-fixture'

const paths = vi.hoisted(() => ({ userData: '' }))
vi.mock('../orca-profiles/profile-storage-paths', () => ({
  getProfileUserDataPath: () => paths.userData
}))

const workers = vi.hoisted(() => ({ byRef: new Map<string, unknown>() }))
vi.mock('./bot-work-runtime', () => ({
  readWorkers: async (_runtime: unknown, refs: readonly string[]) =>
    new Map(refs.map((ref) => [ref, workers.byRef.get(ref) ?? null])),
  readWorkspace: async () => null
}))

const notes = vi.hoisted(() => {
  const drawn: { sessionId: string; note: unknown }[] = []
  return { drawn }
})
vi.mock('../runtime/orca-chat-card', () => ({
  appendOrcaChatCard: (sessionId: string, note: unknown) => notes.drawn.push({ sessionId, note })
}))
vi.mock('../runtime/orchestration/addressing/session-lineage/structured-session-lineage', () => ({
  readAgentSessionRecordStore: () => ({}),
  lineageLiveSession: (_records: unknown, sessionId: string) => ({ sessionId: `${sessionId}-live` })
}))

const owner: BotItemBotActor = { kind: 'bot', botId: 'bot-a', chatId: 'chat-home' }

function worker(dispatchId: string, state: BotWorkWorker['state']): BotWorkWorker {
  return {
    dispatchId,
    taskId: 'task_1',
    title: 'Fix the snapshot test',
    agent: 'codex',
    state,
    stopped: false,
    startFailed: false,
    host: 'local',
    hostName: null,
    worktreeId: null,
    startedAt: 1,
    settledAt: null
  }
}

function item(overrides: Partial<BotItemAddInput> = {}): BotItemAddInput {
  return {
    ownerBotId: 'bot-a',
    chatId: 'chat-home',
    source: { kind: 'home', title: 'Home Chat' },
    title: 'Share dialog',
    status: 'planned',
    links: [],
    ...overrides
  }
}

function fakeHost(
  sendMail: BotItemsHostDeps['sendMail'] = async () => true,
  bots: readonly { id: string; itemsStale?: 'never' | number }[] = []
) {
  const parents = new Map<string, string>()
  const results = new Map<string, string>()
  const starts = new Map<string, { origin: string; creator: string }>()
  const notified: BotChangeScope[] = []
  const db = {
    getDispatchContextById: (id: string) => ({
      follow_up_of_dispatch_id: parents.get(id) ?? null,
      origin_ref: starts.get(id)?.origin ?? null,
      creator_orca_session_id: starts.get(id)?.creator ?? null
    }),
    getTask: (id: string) => (results.has(id) ? { result: results.get(id) } : undefined)
  }
  const client = new BotsDbWorkerClient(inProcessBotsDbWorker().factory)
  const deps = {
    workRuntime: { getOrchestrationDb: () => db },
    db: client,
    bots: () => bots,
    githubCache: () => ({ pr: {}, issue: {} }),
    chatTitle: () => null,
    chatExists: () => true,
    chatRoot: (id: string) => id,
    threadChats: () => [],
    automationRunChats: () => [],
    notify: (scope: BotChangeScope) => notified.push(scope),
    sendMail
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the host reads only these fields of the work runtime and database.
  const host = new BotItemsHost(deps as unknown as BotItemsHostDeps)
  return { host, parents, results, starts, notified }
}

let host: BotItemsHost | null = null

beforeEach(() => {
  paths.userData = mkdtempSync(join(tmpdir(), 'bot-items-'))
  workers.byRef.clear()
  notes.drawn.length = 0
})

afterEach(() => {
  host?.dispose()
  host = null
  closeBotsDbStores()
  rmSync(paths.userData, { recursive: true, force: true })
})

describe('bot items host', () => {
  it("counts each bot's Needs you items that aren't stale, by its own stale setting, and when the next goes stale", async () => {
    const asked = Date.UTC(2026, 10, 15, 9)
    vi.useFakeTimers({ toFake: ['Date'], now: asked })
    host = fakeHost(undefined, [{ id: 'bot-a' }, { id: 'bot-b', itemsStale: 'never' }]).host
    const store = host.store()
    const ask = async (botId: string) => {
      const actor = { ...owner, botId }
      const { uid } = await store.add(item({ ownerBotId: botId }), actor)
      await store.set(uid, { status: 'needs_you', comment: 'Ship it?' }, actor)
    }
    await ask('bot-a')
    await ask('bot-a')
    await ask('bot-b')
    await store.add(item(), owner)
    vi.useRealTimers()
    const sixDays = 6 * 24 * 60 * 60_000

    // bot-a's asks go stale on its default 5 days; bot-b's never do.
    expect(await host.needsYouCounts(asked)).toEqual({
      counts: { 'bot-a': 2, 'bot-b': 1 },
      at: asked,
      staleInMs: 5 * 24 * 60 * 60_000
    })
    expect(await host.needsYouCounts(asked + sixDays)).toEqual({
      counts: { 'bot-b': 1 },
      at: asked + sixDays
    })
  })

  it('sends every owed mail, past a page and past one that fails, leaving only that one owed', async () => {
    const sent: number[] = []
    const fake = fakeHost(async (mail) => {
      if (mail.id === 2) {
        throw new Error('mailbox busy')
      }
      sent.push(mail.id)
      return true
    })
    host = fake.host
    const store = host.store()
    const { uid } = await store.add(item(), owner)
    for (let i = 0; i < 60; i += 1) {
      await store.ownerComment(uid, `Note ${i}`, { kind: 'owner' })
    }

    await host.sendOwedMail()

    expect(sent).toHaveLength(59)
    expect(sent).not.toContain(2)
    const left = await store.owedMail(0)
    expect(left.mails.map((mail) => mail.id)).toEqual([2])
  })

  it("shows a follow-up's worker and its report on the item that linked the original, writing nothing", async () => {
    const fake = fakeHost()
    host = fake.host
    const store = host.store()
    const links = [{ kind: 'dispatch' as const, ref: 'ctx_1' }]
    const { uid } = await store.add(item({ status: 'working', links }), owner)
    fake.parents.set('ctx_2', 'ctx_1')
    fake.results.set(
      'task_1',
      JSON.stringify({ subject: 'Fixed the snapshot test', body: 'PR #41180' })
    )
    workers.byRef.set('ctx_1', { ...worker('ctx_2', 'completed'), settledAt: 5 })
    const before = await store.events(uid, 0, 50)

    const record = await store.get(uid)
    const [view] = await host.views(record ? [record] : [])

    expect(view?.links).toEqual([
      {
        kind: 'dispatch',
        ref: 'ctx_1',
        latest: 'ctx_2',
        title: 'Fix the snapshot test',
        state: 'completed',
        host: null,
        startedAt: 1,
        settledAt: 5,
        report: { subject: 'Fixed the snapshot test', body: 'PR #41180' },
        pr: null
      }
    ])
    expect(await store.events(uid, 0, 50)).toEqual(before)
  })

  it("records worker-start's move to In progress as the starting chat's write, and draws it there", async () => {
    const fake = fakeHost()
    host = fake.host
    const store = host.store()
    // Added earlier, so the add is its own write.
    const { uid } = await store.add(item(), owner, Date.now() - 1000)
    fake.starts.set('ctx_1', { origin: `bot-item:${uid}`, creator: 'chat-home' })

    host.dispatchChanged('ctx_1')

    await vi.waitFor(() => expect(notes.drawn).toHaveLength(1))
    const events = await store.events(uid, 0, 50)
    expect(events.slice(1).map(({ kind, actor }) => ({ kind, actor }))).toEqual([
      { kind: 'linked', actor: owner },
      { kind: 'status', actor: owner }
    ])
    expect(notes.drawn[0]).toMatchObject({
      sessionId: 'chat-home-live',
      note: {
        by: 'bot',
        entries: [
          { uid, event: 'linked', refs: ['dispatch:ctx_1'] },
          { uid, event: 'status', from: 'planned', to: 'working' }
        ]
      }
    })
  })
  it("re-reads an item linked after its worker's Dispatch, and its follow-up's", async () => {
    const fake = fakeHost()
    host = fake.host
    const store = host.store()
    const { uid } = await store.add(item({ status: 'working' }), owner)
    fake.parents.set('ctx_2', 'ctx_1')
    await heartbeats(host, 'ctx_2', 2)
    expect(fake.notified).toEqual([])

    await store.link(uid, [{ kind: 'dispatch', ref: 'ctx_1' }], owner)
    await heartbeats(host, 'ctx_2', 1)

    expect(fake.notified).toEqual([
      { botIds: ['bot-a'], kinds: ['items'], itemUids: { 'bot-a': [uid] } }
    ])
  })

  it('re-reads a linked item on a Dispatch change in a fresh runtime, before any write', async () => {
    const first = fakeHost()
    host = first.host
    const links = [{ kind: 'dispatch' as const, ref: 'ctx_1' }]
    const { uid } = await host.store().add(item({ status: 'working', links }), owner)
    host.dispose()
    closeBotsDbStores()

    const fake = fakeHost()
    host = fake.host
    host.store()
    await heartbeats(host, 'ctx_1', 1)

    expect(fake.notified).toEqual([
      { botIds: ['bot-a'], kinds: ['items'], itemUids: { 'bot-a': [uid] } }
    ])
  })
})

/** Each change in its own turn, its flush and any worker answers settled before the next. */
async function heartbeats(host: BotItemsHost, dispatchId: string, n: number): Promise<void> {
  for (let i = 0; i < n; i += 1) {
    host.dispatchChanged(dispatchId)
    for (let tick = 0; tick < 6; tick += 1) {
      await new Promise((resolve) => setImmediate(resolve))
    }
  }
}
