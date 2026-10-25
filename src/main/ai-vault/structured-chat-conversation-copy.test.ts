import {
  agentSessionRecordFixture,
  agentSessionLeaseFixture
} from '../../shared/agent-session-record.test-fixture'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionProviderHandle } from '../../shared/agent-session-provider-handle'
import type { AiVaultPrepareSessionResumeArgs } from '../../shared/ai-vault-resume-preparation'
import { setStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import { copyStructuredChatConversation } from './structured-chat-conversation-copy'
import { installCopyingChat as installChat } from './structured-session-ownership.test-support'

const OMP_ID = '019fd611-2b3c-7d4e-9f50-6b7c8d9e0f1a'
const OPENCODE_ID = 'ses_2f9aB3cD4eF5gH6iJ7kL8mN9oP'
const OMP_FILE = `/sessions/${OMP_ID}.jsonl`

const acp = (agent: 'opencode' | 'omp', nativeId: string): AgentSessionProviderHandle => ({
  transport: 'acp',
  agent,
  nativeId
})

const fork = (
  overrides: Partial<AiVaultPrepareSessionResumeArgs>
): AiVaultPrepareSessionResumeArgs => ({
  agent: 'omp',
  sessionId: OMP_ID,
  filePath: OMP_FILE,
  codexHome: null,
  executionHostId: 'local',
  fork: true,
  ...overrides
})

afterEach(() => setStructuredAgentSessionHost(null))

describe('copying a chat conversation for Resume in New CLI', () => {
  it.each([
    { agent: 'omp' as const, handle: acp('omp', OMP_ID), sessionId: OMP_ID },
    { agent: 'opencode2' as const, handle: acp('opencode', OPENCODE_ID), sessionId: OPENCODE_ID }
  ])(
    "has the chat's host copy a $agent row's conversation",
    async ({ agent, handle, sessionId }) => {
      const copy = vi.fn(async () => ({
        sessionId: 'copy-1',
        filePath: '/sessions/copy-1.jsonl'
      }))
      installChat(handle, copy)

      await expect(
        copyStructuredChatConversation(fork({ agent, sessionId, filePath: `/x/${sessionId}` }))
      ).resolves.toEqual({
        useRealCodexHome: false,
        forkedSession: {
          sessionId: 'copy-1',
          filePath: '/sessions/copy-1.jsonl',
          agent: handle.agent
        }
      })
    }
  )

  it.each(['source', 'owned'])('rejects a %s fork id on the execution host', async (returned) => {
    const lease = agentSessionLeaseFixture()
    const fixture = agentSessionRecordFixture(lease)
    const copy = vi.fn(async () => ({
      sessionId: returned === 'source' ? OMP_ID : 'other-owned'
    }))
    installChat(acp('omp', OMP_ID), copy, [
      {
        ...fixture,
        sessionId: 'other-chat',
        provider: 'omp',
        providerHandleChain: [
          { ...fixture.providerHandleChain[0]!, handle: acp('omp', 'other-owned') }
        ]
      }
    ])
    await expect(copyStructuredChatConversation(fork({}))).rejects.toThrow(
      'already owned by a chat'
    )
  })
})
