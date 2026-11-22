import { describe, expect, it } from 'vitest'
import { adoptSessionToolCaller } from './session-tool-caller'

// A shared tool process keeps the identity of whichever chat started it.
const inherited = () => ({
  ORCA_AGENT_SESSION_TOOL_TOKEN: 'token-b',
  ORCA_AGENT_SESSION_ID: 'chat-a',
  ORCA_TERMINAL_HANDLE: 'term_a',
  ORCA_BOT_TOOLS_TOKEN: 'bot-a-secret'
})

describe('adoptSessionToolCaller', () => {
  it("takes the host's identity for the token, never the inherited one", async () => {
    const env: NodeJS.ProcessEnv = inherited()
    await adoptSessionToolCaller(env, async (token) =>
      token === 'token-b' ? { env: { ORCA_AGENT_SESSION_ID: 'chat-b' } } : { env: null }
    )
    expect(env).toEqual({ ORCA_AGENT_SESSION_ID: 'chat-b' })
  })

  it('keeps no identity when the host names no one or cannot answer', async () => {
    for (const answer of [
      async () => ({ env: null }),
      async () => {
        throw new Error('runtime_unavailable')
      }
    ]) {
      const env: NodeJS.ProcessEnv = inherited()
      await adoptSessionToolCaller(env, answer)
      expect(env).toEqual({})
    }
  })
})
