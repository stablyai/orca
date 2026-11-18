import { afterEach, expect, it } from 'vitest'
import { fakeSearchService } from '../../shared/ai-vault/search/ai-vault-search-test-fixture'
import { setSessionSearchService } from '../ai-vault-search/session-search-service-registry'
import {
  installSessionSearchPolicySource,
  resetSessionSearchPolicyForTests
} from '../ai-vault-search/session-search-policy'
import { indexedChatMatches } from './bot-chat-search-host'
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
