import {
  agentSessionRecordFixture,
  agentSessionLeaseFixture
} from '../../../shared/agent-session/lifecycle/agent-session-record.test-fixture'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionProviderHandle } from '../../../shared/agent-session/lifecycle/agent-session-provider-handle'
import type { AiVaultPrepareSessionResumeArgs } from '../../../shared/ai-vault/resume/ai-vault-resume-preparation'
import { setStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { copyStructuredChatConversation } from './structured-chat-conversation-copy'
import { installCopyingChat as installChat } from './structured-session-ownership.test-support'

const OMP_ID = '019fd611-2b3c-7d4e-9f50-6b7c8d9e0f1a'

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
