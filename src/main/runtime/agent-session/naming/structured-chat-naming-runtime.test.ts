import { expect, it, vi } from 'vitest'
import { agentSessionRecordFixture } from '../../../../shared/agent-session/lifecycle/records/agent-session-record.test-fixture'
import { getDefaultSourceControlAiSettings } from '../../../../shared/source-control/ai/settings/source-control-ai-settings'
import { createStructuredAgentSessionLogger } from '../../../native-chat/agent-session-wire/host/structured-agent-session-logger'
import { structuredChatNamingDeps } from './structured-chat-naming-runtime'

vi.mock('../../../native-chat/agent-session-wire/host/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => ({
    deps: {
      adapter: {
        generateConversationName: async () => 'Provider generated title',
        generateText: async ({ prompt }: { prompt: string }) => prompt
      }
    }
  })
}))

it('honors a custom Trae naming template when native naming is available', async () => {
  const sourceControlAi = getDefaultSourceControlAiSettings()
  const settings = {
    nativeChatAutoName: true,
    sourceControlAi: {
      ...sourceControlAi,
      actions: {
        ...sourceControlAi.actions,
        conversationName: { commandInputTemplate: 'Work: {firstPrompt}' }
      }
    }
  }
  const naming = structuredChatNamingDeps(
    () => ({ getSettings: () => settings }),
    {
      resolveWorkspace: async () => ({ path: '/workspace', executionHostId: 'local' }),
      resolveNamingEnvironment: async () => ({}),
      getAgentEnvResolvers: () => undefined,
      workerTaskTitle: () => null,
      retitleOpenTab: () => {}
    },
    createStructuredAgentSessionLogger()
  )
  const record = {
    ...agentSessionRecordFixture(),
    provider: 'trae' as const,
    accountHome: { variable: 'TRAECLI_HOME' as const, path: '/account' }
  }
  expect(await naming.generate(record, 'Repair login flow')).toEqual({
    name: 'Work: Repair login flow'
  })
})
