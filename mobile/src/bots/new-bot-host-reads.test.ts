import { expect, it } from 'vitest'
import { BotSessionStart } from '../../../src/shared/rpc-contract/bots-params'
import { createFakeRpcClient } from '../mobile-web-shell/test-support/bridge-host-test-fakes'
import { FakeSession } from '../transport/connection/mobile-endpoint-supervisor-test-fakes'
import { readBotAgentChoices, readNewBotAgentChoices } from './new-bot-host-reads'

it('keeps a host-advertised Muse side chat through the mobile launch contract', async () => {
  const client = new FakeSession('connected')
  client.sendRequest.mockResolvedValue({
    id: 'bot-agents',
    ok: true,
    result: { agents: ['muse', 'a-new-provider-the-phone-does-not-know'] },
    _meta: { runtimeId: 'desktop' }
  })

  const choices = await readBotAgentChoices(client)
  expect(choices).toEqual(['muse'])
  expect(BotSessionStart.parse({ botId: 'local-bot', agent: choices[0] }).agent).toBe('muse')
})

it("reads the host's New bot default agent", async () => {
  const client = createFakeRpcClient()
  const read = readNewBotAgentChoices(client)
  client.requests[0]?.resolve({
    id: 'rpc-1',
    ok: true,
    result: { agents: ['claude', 'codex'], defaultAgent: 'codex' }
  })
  expect(await read).toEqual({ agents: ['claude', 'codex'], defaultAgent: 'codex' })
})

it("picks an older host's default by the New bot priority, not display order", async () => {
  const client = createFakeRpcClient()
  const read = readNewBotAgentChoices(client)
  client.requests[0]?.resolve({
    id: 'rpc-1',
    ok: true,
    result: { agents: ['antigravity', 'grok'] }
  })
  expect(await read).toEqual({ agents: ['antigravity', 'grok'], defaultAgent: 'grok' })
})
