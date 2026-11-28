// Item-chat mail that brings files is not held to the bot request limits yet; text-only mail is.
import '../../../dispatch/testing/unused-default-rpc-methods.test-fixture'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BotItemsStore } from '../../../../../bots/bot-items-store'
import { AgentSessionAttachmentStore } from '../../../../../native-chat/agent-session-attachments/agent-session-attachment-store'
import {
  agentSessionAttachmentReferences,
  agentSessionAttachmentStoreRoot
} from '../../../../../native-chat/agent-session-attachments/agent-session-attachment-references'
import { setAgentSessionAttachmentStore } from '../../../../../native-chat/agent-session-attachments/agent-session-attachment-store-registry'
import type { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import { createOrchestrationRpcHarness } from '../rpc-test-harness'
import type * as RecipientRouting from './recipient-routing'
import {
  DOCS_CHAT,
  journals,
  message,
  RANGER_THREAD,
  setupBotMail
} from './bot-recipient.test-fixture'

vi.mock(
  '../../../../../bots/bot-session-tabs',
  async () => (await import('./bot-recipient.test-fixture')).botSessionTabsMock
)
vi.mock(
  '../../../../../bots/bot-chat-session',
  async () => (await import('./bot-recipient.test-fixture')).botChatSessionMock
)
vi.mock(
  '../../../../../bots/bot-chat-mail-hold',
  async () => (await import('./bot-recipient.test-fixture')).botChatMailHoldMock
)
vi.mock(
  '../../../../../bots/bot-chat-status-line',
  async () => (await import('./bot-recipient.test-fixture')).botChatStatusLineMock
)
vi.mock('./recipient-routing', async (importOriginal) =>
  (await import('./bot-recipient.test-fixture')).recipientRoutingMock(
    await importOriginal<typeof RecipientRouting>()
  )
)
// The item's chat is Docs' Home Chat, live on this host.
vi.mock('../../bots-chats', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  botChatTakingMail: async () => ({ title: null, sessionId: DOCS_CHAT })
}))

describe("an item's mail to another bot past the request limits", () => {
  const h = createOrchestrationRpcHarness()
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let send: ReturnType<typeof setupBotMail>['send']
  let sent: ReturnType<typeof setupBotMail>['sent']
  let root: string
  let items: BotItemsStore
  /** The uploads claimed for each chat, as `upload:session`. */
  const claims = new Set<string>()

  beforeEach(() => {
    ;({ db, runtime, send, sent } = setupBotMail(h))
    root = mkdtempSync(join(tmpdir(), 'orca-item-mail-limits-'))
    // The store's own root: only paths under it are uploads its claims read.
    const uploads = agentSessionAttachmentStoreRoot(root)
    mkdirSync(uploads)
    claims.clear()
    setAgentSessionAttachmentStore(
      new AgentSessionAttachmentStore(uploads, { hasSession: () => true }),
      async (sessionId, body) => {
        for (const uploadId of agentSessionAttachmentReferences(uploads, body)) {
          claims.add(`${uploadId}:${sessionId}`)
        }
      }
    )
    items = BotItemsStore.open(':memory:')
    items.add(
      {
        ownerBotId: 'docs',
        chatId: DOCS_CHAT,
        source: { kind: 'home', title: null },
        title: 'Install guide',
        status: 'working',
        links: []
      },
      { kind: 'bot', botId: 'docs', chatId: DOCS_CHAT }
    )
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: item mail reads only byNumber and get of the store.
    const remote = items as unknown as ReturnType<typeof runtime.botItems.store>
    vi.spyOn(runtime.botItems, 'store').mockReturnValue(remote)
    vi.spyOn(runtime.botItems, 'owningChat').mockReturnValue({
      id: DOCS_CHAT,
      kind: 'home',
      title: null
    })
  })
  afterEach(() => {
    setAgentSessionAttachmentStore(null)
    items.dispose()
    rmSync(root, { recursive: true, force: true })
    h.cleanup()
  })

  it('delivers mail with files, its files claimed for the item chat, and refuses the same text alone', async () => {
    // Ranger's 30 requests to Docs in this window, and its turn woken by the chain's 12th hand-off.
    for (let request = 0; request < 30; request += 1) {
      db.reserveBotRequest({
        messageId: `msg_earlier_${request}`,
        rootKey: 'earlier',
        fromBotId: 'ranger',
        toBotId: 'docs',
        purpose: 'status',
        depth: request === 0 ? 12 : 1,
        record: JSON.stringify({ askers: [{ kind: 'owner' }] })
      })
    }
    journals[RANGER_THREAD] = [
      message('woken', {
        from: {
          kind: 'agent',
          senders: [],
          orchestration: {
            message: 'mail-notice',
            mailbox: `orca_session_id:${RANGER_THREAD}`,
            dispatchId: null,
            messages: [{ messageId: 'msg_earlier_0', runId: 'run', from: 'x' }]
          }
        }
      })
    ]
    const notes = join(root, 'notes.txt')
    writeFileSync(notes, 'release notes draft')
    const question = { to: 'bot:Docs', type: 'question', subject: 'the notes', item: '1' }

    const withFiles = await sent(RANGER_THREAD, { ...question, files: [notes] })
    const delivered = db.getMessageById(withFiles.message.id)
    expect(delivered?.to_handle).toBe(`orca_session_id:${DOCS_CHAT}`)
    expect(delivered?.body).toMatch(/notes\.txt/)
    expect([...claims].map((claim) => claim.split(':')[1])).toEqual([DOCS_CHAT])

    // Text-only mail is held to both: the chain's 13th hand-off, then the pair's 31st request.
    const textOnly = { ...question, subject: 'the notes, again' }
    await expect(send(RANGER_THREAD, textOnly)).rejects.toMatchObject({
      code: 'bot_request_chain_limit'
    })
    journals[RANGER_THREAD] = [message('ask')]
    await expect(send(RANGER_THREAD, textOnly)).rejects.toMatchObject({
      code: 'bot_request_rate_limit'
    })
  })
})
