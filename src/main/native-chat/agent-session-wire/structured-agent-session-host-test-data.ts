import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import type { AgentSessionExecutionLocation } from '../../../shared/agent-session-record'
import { attachFingerprintFields } from './structured-agent-session-attach'
import type { AgentSessionAttachParams } from './structured-agent-session-attach'

export const HOST_TEST_NOW = 1_800_000_000_000
export const HOST_TEST_SESSION = 'session-alpha'
export const HOST_TEST_THREAD = '019fd532-7c11-7a90-b6de-4e1a2c3d5f60'

export const HOST_TEST_LOCATION: AgentSessionExecutionLocation = {
  executionHostId: 'local',
  wslDistro: null,
  workspaceId: 'workspace-1',
  workspaceKind: 'git-worktree'
}

let operations = 0

export function resetHostTestOperationIds(): void {
  operations = 0
}

export function hostTestOperationId(): string {
  operations += 1
  return `${HOST_TEST_NOW}-${operations.toString(16).padStart(32, '0')}`
}

export function hostTestMessage(text: string): AgentJournalMessageItem {
  return { kind: 'message', role: 'user', blocks: [{ type: 'text', text }] }
}

export function hostTestAttachParams(
  expectedRuntimeFence: number | null,
  overrides: Partial<AgentSessionAttachParams> = {}
): AgentSessionAttachParams {
  const params: AgentSessionAttachParams = {
    envelope: {
      sessionId: HOST_TEST_SESSION,
      clientOperationId: hostTestOperationId(),
      expectedRuntimeFence,
      payloadFingerprint: '0'.repeat(64)
    },
    location: HOST_TEST_LOCATION,
    provider: 'codex',
    agent: 'codex',
    accountHome: { variable: 'CODEX_HOME', path: '/home/dev/.codex' },
    runtimeKind: 'native',
    providerHandle: { kind: 'codex', threadId: HOST_TEST_THREAD },
    ...overrides
  }
  return {
    ...params,
    envelope: {
      ...params.envelope,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.attach',
        sessionId: params.envelope.sessionId,
        fields: attachFingerprintFields(params)
      })
    }
  }
}
