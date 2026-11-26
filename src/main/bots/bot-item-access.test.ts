import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { OWNER_ACTS_FOR, type BotRequestAsker } from '../../shared/bots/bot-acts-for'
import { testOrcaSessionId } from '../../shared/agent-session/identity/orca-session-address-test-fixture'
import type { DispatchCreator } from '../runtime/orchestration/db/dispatch-depth'
import { OrchestrationDb } from '../runtime/orchestration/db/orchestration-db'
import { resolveItem } from '../runtime/rpc/methods/bots-items-write-support'
import SyncDatabase from '../sqlite/sync-database'
import {
  botItemAccessOfCaller,
  botItemAccessOfChat,
  botItemAddedFor,
  botItemListScope,
  type BotItemAccess
} from './bot-item-access'
import { BOT_ITEMS_MIGRATIONS } from './bot-items-schema'
import { BotItemsStore } from './bot-items-store'
import { botShareAsker } from './team-share/bot-share-chats'

const OWNER_CHAT = '11111111-1111-4111-8111-111111111111'
const TEAMMATE_CHAT = '22222222-2222-4222-8222-222222222222'
const SLACK_CHAT = '33333333-3333-4333-8333-333333333333'
const SHARED_CHAT = '44444444-4444-4444-8444-444444444444'

const teammate = (accountId: string): BotRequestAsker =>
  botShareAsker({ kind: 'bot-share', botId: 'bot-1', accountId, name: accountId })

let directory = ''
let db: OrchestrationDb
let store: BotItemsStore
const sources = {
  getOrchestrationDb: () => db,
  listAutomationRuns: () => [],
  showAutomation: () => {
    throw new Error('none')
  }
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-bot-item-access-'))
  db = new OrchestrationDb(join(directory, 'orchestration.db'))
  db.recordBotConversationActsFor(OWNER_CHAT, { actsFor: [...OWNER_ACTS_FOR] })
  db.recordBotConversationActsFor(TEAMMATE_CHAT, { actsFor: [teammate('acct-2')] })
  // acct-2's linked Slack login, as the cloud stamps it.
  db.recordBotConversationActsFor(SLACK_CHAT, {
    actsFor: [
      {
        kind: 'person',
        source: 'slack',
        userId: 'U2',
        name: 'Kim',
        workspaceId: 'T1',
        role: 'member',
        viaAccount: 'acct-2'
      }
    ]
  })
  db.recordBotConversationActsFor(SHARED_CHAT, {
    actsFor: [teammate('acct-2'), teammate('acct-3')]
  })
  store = BotItemsStore.open(':memory:')
})
afterEach(() => {
  store.dispose()
  db.close()
  rmSync(directory, { recursive: true, force: true })
})

// A chat's own calls, as the host verified them: its session, at its session address.
const chat = (sessionId: string) => ({
  identity: { handle: `orca_session_id:${sessionId}`, sessionId }
})

function addItem(title: string, actsForAccounts: readonly string[] | null): void {
  store.add(
    {
      ownerBotId: 'bot-1',
      chatId: OWNER_CHAT,
      source: { kind: 'home', title: null },
      actsForAccounts,
      title,
      status: 'working',
      links: []
    },
    { kind: 'bot', botId: 'bot-1', chatId: OWNER_CHAT }
  )
}

const listed = (access: BotItemAccess) =>
  store
    .list({ botId: 'bot-1', statuses: ['working'], limit: 10, ...botItemListScope(access) })
    .items.map((item) => item.title)
    .toSorted()

it("reads an item from before teammates as the owner's: his chats reach it, a teammate's never", async () => {
  // An items file as the build before this one left it, with one item.
  const path = join(directory, 'bot-items.sqlite')
  const old = new SyncDatabase(path)
  BOT_ITEMS_MIGRATIONS.slice(0, 4).forEach((step) => old.exec(step))
  old.exec(`PRAGMA user_version = 4`)
  old.exec(`INSERT INTO items (uid, number, owner_bot_id, chat_id, source, title, status, version,
    last_event_id, last_activity_at, created_at, updated_at)
    VALUES ('u1', 7, 'bot-1', '${OWNER_CHAT}', '{"kind":"home","title":null}', 'Old work', 'working',
    0, 0, 1, 1, 1)`)
  old.close()

  const upgraded = BotItemsStore.open(path)
  try {
    expect(upgraded.get('u1')?.actsForAccounts).toBeNull()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: resolveItem reads only these two store calls
    const remote = {
      byNumber: async (number: number) => upgraded.byNumber(number),
      get: async (uid: string) => upgraded.get(uid)
    } as never
    const owner = botItemAccessOfCaller(sources, chat(OWNER_CHAT))
    const theirs = botItemAccessOfCaller(sources, chat(TEAMMATE_CHAT))
    const share = botItemAccessOfCaller(sources, {
      share: { kind: 'bot-share', botId: 'bot-1', accountId: 'acct-2', name: 'Kim' }
    })
    expect((await resolveItem(remote, '7', owner)).uid).toBe('u1')
    await expect(resolveItem(remote, '7', theirs)).rejects.toThrow('No item 7')
    await expect(resolveItem(remote, 'u1', share)).rejects.toThrow('was never made')
  } finally {
    upgraded.dispose()
  }
})

/** A worker as `worker-start` makes it, its stamp written by the real insert, then bound to the
 *  session or terminal it runs in. */
function startWorker(
  creator: DispatchCreator,
  runsIn: { session: string } | { terminal: string },
  retryOf?: string
): string {
  const taskId = retryOf
    ? db.getDispatchContextById(retryOf)!.task_id
    : db.createTask({ runId: 'run_legacy_local', spec: 'Look into it' }).id
  const { dispatch } = db.createStartingWorkerDispatch({
    creator,
    maxDepth: 10,
    taskId,
    startOptions: { agent: 'claude' },
    ...(retryOf ? { retryOf } : {})
  })
  const handle = 'session' in runsIn ? `orca_session_id:${runsIn.session}` : runsIn.terminal
  db.db
    .prepare(
      'UPDATE dispatch_contexts SET assignee_handle = ?, assignee_orca_session_id = ? WHERE id = ?'
    )
    .run(handle, 'session' in runsIn ? runsIn.session : null, dispatch.id)
  return handle
}

const fromSession = (sessionId: string): DispatchCreator => ({
  kind: 'session',
  orcaSessionId: testOrcaSessionId(sessionId)
})
const reachOf = (handle: string) => listed(botItemAccessOfCaller(sources, { identity: { handle } }))

it("gives every worker under a teammate's chat, chat or terminal, only that teammate's items", () => {
  addItem('Owner work', null)
  addItem('Kim work', ['acct-2'])
  const [a, b, c] = [
    '66666666-6666-4666-8666-666666666661',
    '66666666-6666-4666-8666-666666666662',
    '66666666-6666-4666-8666-666666666663'
  ]
  startWorker(fromSession(TEAMMATE_CHAT), { session: a })
  startWorker(fromSession(a), { session: b })
  const subSub = startWorker(fromSession(b), { session: c })
  expect(reachOf(subSub)).toEqual(['Kim work'])

  const terminal = startWorker(fromSession(TEAMMATE_CHAT), { terminal: 'term_kim' })
  expect(reachOf(terminal)).toEqual(['Kim work'])
})

it("gives the owner's terminal workers, and a Dispatch from before stamps, everyone's items", () => {
  addItem('Owner work', null)
  addItem('Kim work', ['acct-2'])
  const ownerTerminal = startWorker(
    { kind: 'terminal', handle: 'term_owner' },
    { terminal: 'term_owner_worker' }
  )
  expect(reachOf(ownerTerminal)).toEqual(['Kim work', 'Owner work'])

  const old = startWorker(fromSession(TEAMMATE_CHAT), { terminal: 'term_old' })
  db.db
    .prepare("UPDATE dispatch_contexts SET acts_for = NULL WHERE assignee_handle = 'term_old'")
    .run()
  expect(reachOf(old)).toEqual(['Kim work', 'Owner work'])
})

it("decides a chat's people the same for every channel, and a shared chat never reaches the owner's", () => {
  addItem('Owner work', null)
  addItem('Kim work', ['acct-2'])
  addItem('Lee work', ['acct-3'])
  addItem('Other teammate work', ['acct-4'])

  expect(listed(botItemAccessOfChat(sources, SLACK_CHAT))).toEqual(['Kim work'])
  expect(listed(botItemAccessOfChat(sources, SHARED_CHAT))).toEqual(['Kim work', 'Lee work'])
  expect(listed(botItemAccessOfChat(sources, OWNER_CHAT))).toHaveLength(4)
})

it('makes an item added for another chat act for that chat, and only from a chat that reaches it', () => {
  const owner = botItemAccessOfChat(sources, OWNER_CHAT)
  const theirs = botItemAccessOfChat(sources, TEAMMATE_CHAT)
  expect(botItemAddedFor(sources, owner, TEAMMATE_CHAT)).toEqual(['acct-2'])
  expect(botItemAddedFor(sources, theirs, SLACK_CHAT)).toEqual(['acct-2'])
  expect(() => botItemAddedFor(sources, theirs, OWNER_CHAT)).toThrow('for someone else')
  expect(() => botItemAddedFor(sources, theirs, SHARED_CHAT)).not.toThrow()
})

it("trusts the owner's paired computer as the owner, and only a share device as a teammate", () => {
  addItem('Owner work', null)
  addItem('Kim work', ['acct-2'])
  const kim = { kind: 'bot-share' as const, botId: 'bot-1', accountId: 'acct-2', name: 'Kim' }
  // A paired computer's coordinator, and a worker it starts here (its creator is a peer: handle).
  expect(listed(botItemAccessOfCaller(sources, { peer: true }))).toEqual(['Kim work', 'Owner work'])
  const paired = startWorker({ kind: 'terminal', handle: 'peer:conv-1' }, { terminal: 'term_p' })
  expect(reachOf(paired)).toEqual(['Kim work', 'Owner work'])
  // A share device is the teammate whatever else the call carries.
  expect(listed(botItemAccessOfCaller(sources, { share: kim }))).toEqual(['Kim work'])
  expect(listed(botItemAccessOfCaller(sources, { share: kim, peer: true }))).toEqual(['Kim work'])
})

it("keeps a teammate's worker theirs when the owner retries it, and finds a worker by its pane alone", () => {
  addItem('Owner work', null)
  addItem('Kim work', ['acct-2'])
  startWorker(fromSession(TEAMMATE_CHAT), { terminal: 'term_first' })
  const first = db.getActiveDispatchForIdentity('term_first')!.id
  // It failed, as a worker's start or exit settles it.
  db.db.prepare("UPDATE worker_dispatches SET state = 'failed' WHERE dispatch_id = ?").run(first)
  db.db
    .prepare("UPDATE tasks SET status = 'failed' WHERE id = ?")
    .run(db.getDispatchContextById(first)!.task_id)
  const retried = startWorker(
    { kind: 'terminal', handle: 'term_owner' },
    { terminal: 'term_retry' },
    first
  )
  expect(reachOf(retried)).toEqual(['Kim work'])

  db.db
    .prepare("UPDATE dispatch_contexts SET assignee_pane_key = 'pane-9' WHERE assignee_handle = ?")
    .run(retried)
  expect(
    listed(botItemAccessOfCaller(sources, { identity: { handle: '', paneKey: 'pane-9' } }))
  ).toEqual(['Kim work'])
})
