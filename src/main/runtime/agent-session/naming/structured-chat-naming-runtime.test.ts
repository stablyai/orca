import { describe, expect, it, vi } from 'vitest'
import { getStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host/execution-host'
import { structuredChatNamingDeps } from './structured-chat-naming-runtime'

vi.mock('../../../native-chat/agent-session-wire/host/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: vi.fn()
}))

describe('Antigravity chat naming consent', () => {
  it('runs agy only while the person has opted in', async () => {
    const generateText = vi.fn(async (_input: { shouldExecute?: () => boolean }) => 'Fix login')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: naming reads only the adapter's generateText
    vi.mocked(getStructuredAgentSessionHost).mockReturnValue({
      deps: { adapter: { generateText } }
    } as never)
    const settings: { antigravityChatNaming?: boolean } = {}
    const deps = structuredChatNamingDeps(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these settings fall back to defaults
      () => ({ getSettings: () => settings }) as never,
      {
        resolveWorkspace: async () => ({ path: '/repo', executionHostId: LOCAL_EXECUTION_HOST_ID }),
        resolveNamingEnvironment: async () => ({}),
        getAgentEnvResolvers: () => undefined,
        workerTaskTitle: () => null,
        retitleOpenTab: () => {}
      },
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: naming only warns
      { warn: vi.fn() } as never
    )
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: naming reads only these record fields
    const record = {
      sessionId: 'chat-1',
      provider: 'antigravity',
      accountHome: { variable: 'GEMINI_HOME', path: '/home/me/.gemini' },
      location: { workspaceId: 'ws-1', wslDistro: null }
    } as never

    expect(await deps.generate(record, 'the login button does nothing')).toBeNull()
    expect(generateText).not.toHaveBeenCalled()

    settings.antigravityChatNaming = true
    expect(await deps.generate(record, 'the login button does nothing')).toEqual({
      name: 'Fix login'
    })
    const { shouldExecute } = generateText.mock.calls[0]![0]
    expect(shouldExecute?.()).toBe(true)
    // Turning it off stops a run that hasn't sent its prompt yet.
    settings.antigravityChatNaming = false
    expect(shouldExecute?.()).toBe(false)
  })
})
