import { afterEach, expect, it } from 'vitest'
import { fakeSearchService } from '../../shared/ai-vault/search/ai-vault-search-test-fixture'
import { setSessionSearchService } from '../ai-vault-search/session-search-service-registry'
import {
  installSessionSearchPolicySource,
  resetSessionSearchPolicyForTests
} from '../ai-vault-search/session-search-policy'
import type { BotChatTreeChat } from '../../shared/bots/bot-chat-tree'
import { indexedChatMatches, searchBotChats } from './bot-chat-search-host'
import { makeTestBot } from './bot.test-fixture'

afterEach(() => {
  setSessionSearchService(null)
  resetSessionSearchPolicyForTests()
})

const runtime: Parameters<typeof indexedChatMatches>[0] = {
  listFolderWorkspaces: () => [{ id: 'home-1', folderPath: '/bots/home-1' }],
  ensureStructuredAgentSessionHost: async () => null
}

it('never asks the session index (which starts its process) while the owner has it off', async () => {
  const service = fakeSearchService()
  setSessionSearchService(service)
  const bot = makeTestBot({ folderWorkspaceId: 'home-1' })

  installSessionSearchPolicySource(() => ({ aiVaultSearch: { enabled: false, historyDays: null } }))
  expect(await indexedChatMatches(runtime, bot, 'zebra')).toEqual([])
  expect(service.search).not.toHaveBeenCalled()

  installSessionSearchPolicySource(() => ({ aiVaultSearch: { enabled: true, historyDays: null } }))
  await indexedChatMatches(runtime, bot, 'zebra')
  expect(service.search).toHaveBeenCalledTimes(1)
})

it("counts only a worker match's own workers, so Show more is never one it can't fill", async () => {
  const worker = (key: string, title: string) => ({
    key,
    title,
    state: 'running' as const,
    startedAt: 0
  })
  const room: BotChatTreeChat = {
    chatId: 'bot-group-member-1',
    title: 'Release room',
    origin: 'side',
    live: 'idle',
    lastActiveAt: 0,
    unread: false,
    closed: false,
    running: [worker('w1', 'Release notes'), worker('w2', 'Relay auth')],
    runningTotal: 2,
    finished: [],
    finishedTotal: 3,
    failedTotal: 1
  }
  const host: Parameters<typeof searchBotChats>[0] = {
    bots: () => [makeTestBot({ id: 'bot-1' })],
    treeParts: async () => ({
      tree: { chats: [room], workspaceChats: {} },
      placed: [],
      rootOf: (id: string) => id
    }),
    contentMatches: async () => [],
    dispatchWorkers: async () => []
  }

  const answer = await searchBotChats(host, {
    botId: 'bot-1',
    query: 'release'
  })

  expect(answer.chats).toMatchObject([
    { running: [{ key: 'w1' }], runningTotal: 1, finished: [], finishedTotal: 0, failedTotal: 0 }
  ])
})
