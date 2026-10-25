import type { AgentSessionRecord } from '../../shared/agent-session-record'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../shared/agent-session-record.test-fixture'
import type { AgentSessionProviderHandle } from '../../shared/agent-session-provider-handle'
import type { AiVaultListResult, AiVaultSession } from '../../shared/ai-vault-types'
import type { StructuredAgentSessionAdapter } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { StructuredProviderSessionOwnership } from '../native-chat/agent-session-wire/structured-provider-session-ownership'
import { setStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import {
  claudeProviderHandle,
  codexProviderHandle
} from '../../shared/agent-session-provider-handle-encoding'

export const PROVIDER_SESSION = '019fd532-7c11-7a90-b6de-4e1a2c3d5f60'

export function installOwnership(
  overrides: Partial<Omit<StructuredProviderSessionOwnership, 'role' | 'key'>> & {
    handle?: AgentSessionProviderHandle
  } = {}
): void {
  const { handle, ...ownershipOverrides } = overrides
  const ownership: Omit<StructuredProviderSessionOwnership, 'role' | 'key'> = {
    sessionId: 'session-alpha',
    workspaceId: 'workspace-1',
    provider: handle?.agent ?? 'codex',
    providerSessionId: PROVIDER_SESSION,
    lease: agentSessionLeaseFixture(),
    ...ownershipOverrides
  }
  const record = agentSessionRecordFixture(ownership.lease)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the ownership read touches only `deps.store.listRecords`; the rest of the host is never reached.
  setStructuredAgentSessionHost({
    deps: {
      store: {
        listRecords: () => [
          {
            ...record,
            sessionId: ownership.sessionId,
            location: { ...record.location, workspaceId: ownership.workspaceId },
            provider: ownership.provider,
            providerHandleChain: [
              {
                ...record.providerHandleChain[0]!,
                handle:
                  handle ??
                  (ownership.provider === 'claude'
                    ? claudeProviderHandle(ownership.providerSessionId, null)
                    : codexProviderHandle(ownership.providerSessionId))
              }
            ],
            lease: { ...ownership.lease, sessionId: ownership.sessionId },
            ...(ownership.conversationName ? { conversationName: ownership.conversationName } : {})
          }
        ]
      }
    }
  } as never)
}

export function installCopyingChat(
  handle: AgentSessionProviderHandle,
  copy: StructuredAgentSessionAdapter['copyConversation'],
  otherRecords: AgentSessionRecord[] = []
): void {
  const lease = { ...agentSessionLeaseFixture(), sessionId: 'chat-1' }
  const fixture = agentSessionRecordFixture(lease)
  const record = {
    ...fixture,
    sessionId: 'chat-1',
    provider: handle.agent,
    location: { ...fixture.location, workspaceId: 'workspace-1' },
    providerHandleChain: [{ ...fixture.providerHandleChain[0]!, handle }],
    lease
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a copy reads only `deps.store` and `deps.adapter.copyConversation`; the rest of the host is never reached.
  setStructuredAgentSessionHost({
    deps: {
      store: {
        listRecords: () => [record, ...otherRecords],
        getRecord: (sessionId: string) => (sessionId === record.sessionId ? record : null)
      },
      adapter: { copyConversation: copy }
    }
  } as never)
}

/** A live Codex chat whose chain held `threadIds` in order; the last is its head. */
export function codexChatHolding(sessionId: string, threadIds: string[]): AgentSessionRecord {
  const lease = { ...agentSessionLeaseFixture(), sessionId }
  const fixture = agentSessionRecordFixture(lease)
  return {
    ...fixture,
    sessionId,
    provider: 'codex',
    providerHandleChain: threadIds.map((threadId, index) => ({
      ...fixture.providerHandleChain[0]!,
      linkId: `${sessionId}-${index}`,
      handle: codexProviderHandle(threadId)
    })),
    lease
  }
}

export function installChats(records: AgentSessionRecord[]): void {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the ownership read touches only `deps.store.listRecords`; the rest of the host is never reached.
  setStructuredAgentSessionHost({ deps: { store: { listRecords: () => records } } } as never)
}

export function listResult(): AiVaultListResult {
  const session: AiVaultSession = {
    id: `local:codex:${PROVIDER_SESSION}`,
    executionHostId: 'local',
    agent: 'codex',
    sessionId: PROVIDER_SESSION,
    title: 'Owned',
    cwd: '/repo',
    branch: null,
    model: null,
    filePath: `/sessions/rollout-${PROVIDER_SESSION}.jsonl`,
    codexHome: null,
    createdAt: null,
    updatedAt: null,
    modifiedAt: '2026-08-11T00:00:00.000Z',
    messageCount: 1,
    totalTokens: 0,
    previewMessages: [],
    queuedMessageCount: 0,
    subagentTranscriptCount: 0,
    resumeCommand: `codex resume '${PROVIDER_SESSION}'`,
    subagent: null
  }
  return { sessions: [session], issues: [], scannedAt: '2026-08-11T00:00:00.000Z' }
}
