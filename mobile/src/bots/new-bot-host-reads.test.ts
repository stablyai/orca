import { expect, it } from 'vitest'
import { createFakeRpcClient } from '../mobile-web-shell/test-support/bridge-host-test-fakes'
import { readNewBotAgentChoices } from './new-bot-host-reads'

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
