import { describe, expect, it } from 'vitest'
import { createFakeRpcClient } from '../mobile-web-shell/test-support/bridge-host-test-fakes'
import { ensureBotHomeChat } from './host-bots-read'

describe('ensureBotHomeChat', () => {
  it('names the agent release a refused Home Chat needs', async () => {
    const client = createFakeRpcClient()
    const opened = ensureBotHomeChat(client, 'bot-1')
    // The host's reply when a bot's Hermes is older than chats support (#46838).
    client.requests[0]?.resolve({
      id: 'rpc-1',
      ok: false,
      error: {
        code: 'runtime_error',
        message: 'Your Hermes CLI on this computer is 0.20.5. Chats need 0.23.0 or newer.',
        data: {
          refusal: {
            code: 'structured_agent_session_unsupported',
            details: {
              reason: 'hostUnsupported',
              agentInstallation: {
                agent: 'hermes',
                installedVersion: '0.20.5',
                minimumVersion: '0.23.0'
              }
            }
          }
        }
      }
    })

    // The refusal's own facts, not its copy.
    const refusal = await opened
    expect(refusal).toContain('Hermes')
    expect(refusal).toContain('0.20.5')
    expect(refusal).toContain('0.23.0')
  })
})
