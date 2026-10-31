import { agentSessionConversationView } from '../../shared/agent-session-conversation-view'
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
    accountHome?: AgentSessionRecord['accountHome']
  } = {}
): void {
  const { handle, accountHome, ...ownershipOverrides } = overrides
  const ownership: Omit<StructuredProviderSessionOwnership, 'role' | 'key'> = {
    sessionId: 'session-alpha',
    workspaceId: 'workspace-1',
    provider: handle?.agent ?? 'codex',
    wslDistro: null,
    providerSessionId: PROVIDER_SESSION,
    ownerObservation: agentSessionConversationView(agentSessionRecordFixture()).ownerObservation,
    ...ownershipOverrides
  }
  const record = agentSessionRecordFixture(
    agentSessionLeaseFixture({ sessionId: ownership.sessionId })
  )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the ownership read touches only `deps.store.listConversations`; the rest of the host is never reached.
  setStructuredAgentSessionHost({
    deps: {
      store: {
        listConversations: () => [
          {
            ...agentSessionConversationView({
              ...record,
              sessionId: ownership.sessionId,
              accountHome: accountHome ?? record.accountHome,
              location: {
                ...record.location,
                workspaceId: ownership.workspaceId,
                wslDistro: ownership.wslDistro
              },
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
              lease: record.lease,
              ...(ownership.conversationName
                ? { conversationName: ownership.conversationName }
                : {})
            }),
            ownerObservation: ownership.ownerObservation
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
        listConversations: () => [record, ...otherRecords].map(agentSessionConversationView),
        selectWritableRecord: () => ({ kind: 'writable', record }),
        requireWritableRecord: () => record,
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
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the ownership read touches only `deps.store.listConversations`; the rest of the host is never reached.
  setStructuredAgentSessionHost({
    deps: { store: { listConversations: () => records.map(agentSessionConversationView) } }
  } as never)
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
