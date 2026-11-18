import { describe, expect, it } from 'vitest'
import {
  fakeLinkStore,
  PANE,
  WORKTREE
} from '../external-conversations/external-conversation.test-fixture'
import { openBotDeepLink } from './bot-deep-link-open'

const LINK = { botId: 'bot_1', conversation: { source: 'slack' as const, externalId: 'T1:C1:1' } }
const CHAT_LINK = {
  source: 'slack',
  externalId: 'T1:C1:1',
  paneKey: PANE,
  sessionId: 'chat-1',
  agent: 'claude',
  createdAt: 1
}

function storeWith(externalConversations: unknown[]) {
  const records = fakeLinkStore()
  records.put(WORKTREE, 'local', { externalConversations })
  return records.store
}

describe('openBotDeepLink', () => {
  it('hands a bare link to the renderer to open the bot’s Home', async () => {
    expect(await openBotDeepLink(storeWith([CHAT_LINK]), { botId: 'bot_1' })).toEqual({
      kind: 'home',
      botId: 'bot_1'
    })
  })

  it('hands the conversation’s chat to the renderer by its session', async () => {
    expect(await openBotDeepLink(storeWith([CHAT_LINK]), LINK)).toEqual({
      kind: 'chat',
      workspaceId: WORKTREE,
      sessionId: 'chat-1'
    })
  })

  it('finds the link in a folder workspace', async () => {
    const records = fakeLinkStore()
    records.folders.push({ id: 'folder-1', externalConversations: [CHAT_LINK] })

    expect(await openBotDeepLink(records.store, LINK)).toEqual({
      kind: 'chat',
      workspaceId: 'folder:folder-1',
      sessionId: 'chat-1'
    })
  })

  it('hands a conversation this computer lacks, or an older Orca’s terminal link, to the renderer to find', async () => {
    const missing = { kind: 'home', botId: 'bot_1', conversation: LINK.conversation }
    expect(
      await openBotDeepLink(storeWith([{ ...CHAT_LINK, externalId: 'T1:C1:2' }]), LINK)
    ).toEqual(missing)
    const { sessionId: _, ...terminalLink } = CHAT_LINK
    expect(await openBotDeepLink(storeWith([terminalLink]), LINK)).toEqual(missing)
  })
})

it('opens only a linked bot’s own chat or a local participant worker, with the exact item', async () => {
  const store = storeWith([{ ...CHAT_LINK, bot: { kind: 'bot', botId: 'bot_1' } }])
  const workers = async () => [
    { host: 'local', chatSessionId: 'worker-1', worktreeId: 'folder:worker' }
  ]
  expect(
    await openBotDeepLink(store, { ...LINK, sessionId: 'worker-1', itemId: 'question-7' }, workers)
  ).toEqual({
    kind: 'chat',
    workspaceId: 'folder:worker',
    sessionId: 'worker-1',
    itemId: 'question-7'
  })
  expect(
    await openBotDeepLink(store, { ...LINK, sessionId: 'foreign', itemId: 'private-item' }, workers)
  ).toEqual({ kind: 'chat', workspaceId: WORKTREE, sessionId: 'chat-1' })
})

it.each([undefined, { kind: 'bot' as const, botId: 'other-bot' }])(
  'refuses a targeted link without the matching bot association (%s)',
  async (bot) => {
    expect(
      await openBotDeepLink(storeWith([{ ...CHAT_LINK, ...(bot ? { bot } : {}) }]), {
        ...LINK,
        sessionId: 'chat-1',
        itemId: 'private-question'
      })
    ).toEqual({ kind: 'home', botId: 'bot_1', conversation: LINK.conversation })
  }
)
