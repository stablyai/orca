import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
    expect(env).toEqual({
      ORCA_AGENT_SESSION_TOOL_TOKEN: 'token-b',
      ORCA_AGENT_SESSION_ID: 'chat-b'
    })
  })

  it('runs nothing when the host names no one or cannot answer', async () => {
    for (const answer of [
      async () => ({ env: null }),
      async () => {
        throw new Error('runtime_unavailable')
      }
    ]) {
      const env: NodeJS.ProcessEnv = inherited()
      await expect(adoptSessionToolCaller(env, answer)).rejects.toThrow(/ran nothing/)
      expect(env).toEqual({ ORCA_AGENT_SESSION_TOOL_TOKEN: 'token-b' })
    }
  })

  it("refuses a bot's tool whose token never arrived, and only a bot's", async () => {
    const home = await mkdtemp(join(tmpdir(), 'orca-tool-caller-'))
    try {
      await mkdir(join(home, 'orca-sessions'))
      await writeFile(
        join(home, 'orca-sessions', 'local-bot.json'),
        JSON.stringify({ orcaBot: '1' })
      )
      await writeFile(join(home, 'orca-sessions', 'local-chat.json'), JSON.stringify({}))
      const noTrade = async () => {
        throw new Error('no token to trade')
      }
      await expect(
        adoptSessionToolCaller({ HERMES_HOME: home, HERMES_SESSION_ID: 'local-bot' }, noTrade)
      ).rejects.toThrow(/ran nothing/)
      // A delegated subagent's tool runs under its own session id, beside its chat's.
      await expect(
        adoptSessionToolCaller(
          { HERMES_HOME: home, HERMES_SESSION_ID: 'child', HERMES_SESSION_CHAT_ID: 'local-bot' },
          noTrade
        )
      ).rejects.toThrow(/ran nothing/)
      await expect(
        adoptSessionToolCaller({ HERMES_HOME: home, HERMES_SESSION_ID: 'local-chat' }, noTrade)
      ).resolves.toBeUndefined()
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})
