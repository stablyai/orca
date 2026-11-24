import { expect, it } from 'vitest'
import { BotSessionStart } from '../../../src/shared/rpc-contract/bots-params'
import { FakeSession } from '../transport/connection/mobile-endpoint-supervisor-test-fakes'
import { readBotAgentChoices } from './new-bot-host-reads'

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
