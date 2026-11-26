import { afterEach, expect, it } from 'vitest'
import { agentSessionConversationView } from '../../../../shared/agent-session/lifecycle/leases/agent-session-conversation-view'
import { folderWorkspaceKey } from '../../../../shared/workspace/identity/workspace-scope'
import { testOrcaSessionId } from '../../../../shared/agent-session/identity/orca-session-address-test-fixture'
import { agentSessionRecordFixture } from '../../../native-chat/testing/agent-session-record-test-fixture'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { OrchestrationDb } from '../../orchestration/db/orchestration-db'
import { BOT_CHATS_REOPEN_METHOD } from './bots-chats-reopen'

// An agent reopens one closed chat: right after a restart too, by the id it had before a /clear,
// with the mail that waited for it, and at a cost that doesn't grow with the bot's other chats.

const ROOT = '6c1f5a52-1d1b-4a6e-9a51-6b0c4f0d0001'
const LIVE = '6c1f5a52-1d1b-4a6e-9a51-6b0c4f0d0002'
const BOT = { id: 'bot-1', name: 'Builder', agent: 'claude', folderWorkspaceId: 'bot-home' }

afterEach(() => setStructuredAgentSessionHost(null))

function reopenWith(otherChats: number) {
  const home = folderWorkspaceKey(BOT.folderWorkspaceId)
  const record = (sessionId: string, extra = {}) =>
    agentSessionConversationView(
      agentSessionRecordFixture({ sessionId, location: { workspaceId: home }, ...extra })
    )
  const others = Array.from({ length: otherChats }, (_, index) =>
    record(`6c1f5a52-1d1b-4a6e-9a51-${String(index).padStart(12, '1')}`)
  )
  const views = new Map(
    [
      record(ROOT, {
        conversationCommand: { command: 'clear', phase: 'committed', replacementSessionId: LIVE }
      }),
      record(LIVE),
      ...others
    ].map((view) => [view.sessionId, view])
  )
  const visible = new Set<string>()
  const counts = { lists: 0, reads: 0, statements: 0 }
  const lineage = {}
  const store = {
    getConversation: (id: string) => {
      counts.reads += 1
      return views.get(id) ?? null
    },
    listConversations: () => {
      counts.lists += 1
      return [...views.values()]
    },
    getVisibleSessionTabIndex: () => ({ present: true, sessionIds: [...visible] }),
    lineageRevision: () => lineage
  }
  const db = new OrchestrationDb(':memory:')
  const run = db.createRun({
    objective: 'reports',
    coordinatorHandle: null,
    coordinatorPaneKey: null,
    coordinatorOrcaSessionId: testOrcaSessionId(LIVE)
  }).id
  // Statements the reopen asks of the database, which grew with every chat the bot ever had.
  const prepare = db.db.prepare.bind(db.db)
  db.db.prepare = (sql: string) => {
    counts.statements += 1
    return prepare(sql)
  }
  const woken: string[] = []
  const reopened: string[] = []
  const runtime = {
    // Nothing loaded the chat host since the restart; the reopen opens it.
    ensureStructuredAgentSessionHost: async () => {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the reopen reads only the host's record store.
      setStructuredAgentSessionHost({ deps: { store } } as never)
    },
    bots: { list: () => [BOT] },
    getOrchestrationDb: () => db,
    lookAround: { botOfLook: () => null, botOfTidyUp: () => null },
    publishStructuredAgentSessionTab: async ({ sessionId }: { sessionId: string }) => {
      visible.add(sessionId)
    },
    botRunChatCloser: { reopened: (_bot: unknown, id: string) => reopened.push(id) },
    notifyMessageArrived: (handle: string) => woken.push(handle)
  }
  return {
    counts,
    visible,
    woken,
    reopened,
    run,
    db,
    call: () =>
      BOT_CHATS_REOPEN_METHOD.handler(
        { chatId: LIVE },
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler reads only these runtime members.
        { runtime } as never
      )
  }
}

it('reopens a /clear chat after a restart into its live session and hands over its waiting mail', async () => {
  const reopen = reopenWith(0)
  const result = await reopen.call()
  reopen.db.close()

  expect(result).toEqual({ reopened: true, chatId: ROOT })
  expect([...reopen.visible]).toEqual([LIVE])
  expect(reopen.reopened).toEqual([ROOT])
  expect(reopen.woken).toEqual(
    expect.arrayContaining([`orca_session_id:${LIVE}`, `run:${reopen.run}`])
  )
})

it("reads the same records for one chat whatever the bot's history", async () => {
  const small = reopenWith(10)
  await small.call()
  small.db.close()
  const large = reopenWith(1_000)
  await large.call()
  large.db.close()

  // The /clear index is built once per lineage change and shared; nothing lists per chat.
  expect(large.counts).toEqual(small.counts)
  expect(large.counts.lists).toBeLessThanOrEqual(2)
})
