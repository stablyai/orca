// `item add --from-item`: only the bot's own item's request is joined, by its key alone, and the
// request mail an item made `--for` another bot records that key in `bot_requests.root_key`.
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { BotItemOrigin } from '../../../../shared/bots/bot-items'
import { agentSessionConversationView } from '../../../../shared/agent-session/lifecycle/leases/agent-session-conversation-view'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../../../shared/agent-session/lifecycle/records/agent-session-record.test-fixture'
import { folderWorkspaceKey } from '../../../../shared/workspace/identity/workspace-scope'
import { makeTestBot } from '../../../bots/bot.test-fixture'
import { BotItemsStore } from '../../../bots/bot-items-store'
import type { StructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/host/structured-agent-session-host'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { fromItemOf } from './bots-items-add'
import { sendToBot } from './orchestration/messaging/bot-request-send'
import { createOrchestrationRpcHarness } from './orchestration/rpc-test-harness'

const HOME = 'orca_session_id:home'
const BOARD: BotItemOrigin = {
  rootKey: `${HOME}:u0`,
  kind: 'owner',
  at: 1000,
  request: 'Build a board'
}

const harness = createOrchestrationRpcHarness()
let store: BotItemsStore
beforeEach(() => {
  store = BotItemsStore.open(':memory:')
})
afterEach(() => {
  setStructuredAgentSessionHost(null)
  harness.cleanup()
  store.dispose()
})

const made = (botId: string, origin?: BotItemOrigin) =>
  store.add(
    {
      ownerBotId: botId,
      chatId: HOME,
      source: { kind: 'home', title: null },
      title: 'Plan the board',
      status: 'planned',
      links: [],
      ...(origin ? { origin } : {})
    },
    { kind: 'bot', botId, chatId: HOME }
  ).uid

const remote = {
  byNumber: async (n: number) => store.byNumber(n),
  get: async (uid: string) => store.get(uid),
  originsOf: async (uids: readonly string[]) => store.originsOf(uids)
}

it("joins only one of the bot's own items' requests, by its key", async () => {
  const own = made('coordinator', BOARD)
  made('helper', { ...BOARD, rootKey: `${HOME}:u3` })
  expect(await fromItemOf(remote, '1', 'coordinator')).toEqual({
    uid: own,
    rootKey: `${HOME}:u0`
  })
  await expect(fromItemOf(remote, '2', 'coordinator')).rejects.toThrow(
    '--from-item names one of your own items.'
  )
})

it("stores the named item's key as the request mail's root_key, with the sender's own start", async () => {
  const { db, runtime } = harness.setup()
  // The receiving bot's Home chat, as the native host lists it.
  const sessionId = '22222222-2222-4222-8222-222222222222'
  const docs = makeTestBot({ name: 'Docs', agent: 'claude', chatSessionId: sessionId })
  const saved = agentSessionRecordFixture(agentSessionLeaseFixture({ sessionId }))
  const chat = agentSessionConversationView({
    ...saved,
    location: { ...saved.location, workspaceId: folderWorkspaceKey(docs.folderWorkspaceId) }
  })
  const host = {
    deps: {
      store: {
        getConversation: (id: string) => (id === sessionId ? chat : null),
        listConversations: () => [chat]
      }
    },
    conversation: async () => ({ journal: { queuedMessages: { failureHolds: async () => [] } } }),
    captureAgentStartDestination: async (id: string) => id,
    appendAgentStart: async () => {}
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture implements the native host calls Home admission uses.
  setStructuredAgentSessionHost(host as unknown as StructuredAgentSessionHost)
  vi.spyOn(runtime.bots, 'list').mockReturnValue([docs])
  vi.spyOn(runtime.bots, 'enabled').mockReturnValue(true)
  vi.spyOn(runtime, 'ensureStructuredAgentSessionHost').mockResolvedValue(undefined)
  vi.spyOn(runtime, 'publishStructuredAgentSessionTab').mockResolvedValue()
  vi.spyOn(runtime, 'notifyMessageArrived').mockImplementation(() => {})

  made('coordinator', BOARD)
  const { rootKey } = await fromItemOf(remote, '1', 'coordinator')
  const sent = await sendToBot(
    { runtime, orchestrationCaller: undefined, recordMutationReceipt: undefined },
    {
      params: { subject: 'Test the board', body: 'Made for you.', type: 'handoff' },
      from: 'term_coord',
      to: 'bot:Docs',
      sender: {
        address: 'term_coord',
        terminalHandle: 'term_coord',
        paneKey: harness.coordinatorPaneKey,
        orcaSessionId: null
      },
      routing: { run: undefined },
      messageId: 'msg_item_from',
      ...(rootKey ? { fromItemKey: rootKey } : {})
    }
  )
  expect(sent).not.toBeNull()
  const row = db.getBotRequest('msg_item_from')
  expect(row?.root_key).toBe(BOARD.rootKey)
  // Only the key is joined: the record's start stays the sender's own (a terminal's here).
  expect(JSON.parse(row?.record ?? '{}').start).toEqual({ kind: 'owner', at: null, request: null })
})
