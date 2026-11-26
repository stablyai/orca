import { describe, expect, it } from 'vitest'
import { SharedToolProcessSession, sharedToolProcessCaller } from './shared-tool-process-callers'

const SEALED = {
  PATH: '/usr/bin',
  ORCA_AGENT_SESSION_ID: 'chat-a',
  ORCA_TERMINAL_HANDLE: 'structworker_a',
  ORCA_BOT_TOOLS_TOKEN: 'bot-a-secret',
  ORCA_STRUCTURED_SESSION: '1',
  ORCA_USER_DATA_PATH: '/orca-data',
  ORCA_CLI_COMMAND: '/orca-data/cli/bin/orca',
  ORCA_ENVIRONMENT: ''
}

function launched() {
  const writes: Record<string, string | null>[] = []
  const withdrawn: string[] = []
  const session = SharedToolProcessSession.forLaunch(
    {
      sharedToolProcess: {
        publishSessionEnv: async ({ providerSessionId, values }) => {
          writes.push({ ...values })
          return async () => {
            withdrawn.push(providerSessionId)
          }
        }
      }
    },
    SEALED
  )!
  return { session, writes, withdrawn }
}

describe('SharedToolProcessSession', () => {
  it('gives tools only a token, which names its chat until the chat ends', async () => {
    const { session, writes, withdrawn } = launched()
    await session.publishFor({ link: { handle: { nativeId: 'hermes-1' } } })
    const tools = writes[0]
    // The shared process's own copy of any chat's identity is unset, and none reaches it.
    expect(tools).toMatchObject({
      ORCA_AGENT_SESSION_ID: null,
      ORCA_TERMINAL_HANDLE: null,
      ORCA_BOT_TOOLS_TOKEN: null,
      ORCA_STRUCTURED_SESSION: '1',
      ORCA_USER_DATA_PATH: '/orca-data',
      ORCA_CLI_COMMAND: '/orca-data/cli/bin/orca',
      ORCA_ENVIRONMENT: ''
    })
    expect(Object.values(tools)).not.toContain('bot-a-secret')
    expect(tools.PATH).toBeUndefined()
    const token = tools.ORCA_AGENT_SESSION_TOOL_TOKEN!
    expect(sharedToolProcessCaller(token)).toEqual({
      ORCA_AGENT_SESSION_ID: 'chat-a',
      ORCA_TERMINAL_HANDLE: 'structworker_a',
      ORCA_BOT_TOOLS_TOKEN: 'bot-a-secret'
    })
    expect(sharedToolProcessCaller(`${token}x`)).toBeNull()

    session.end()
    expect(sharedToolProcessCaller(token)).toBeNull()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(withdrawn).toEqual(['hermes-1'])
  })

  it('withdraws a publish that lands after the chat ended', async () => {
    const { session, withdrawn } = launched()
    const publish = session.publishFor({ link: { handle: { nativeId: 'hermes-1' } } })
    session.end()
    await publish
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(withdrawn).toEqual(['hermes-1'])
  })
})
