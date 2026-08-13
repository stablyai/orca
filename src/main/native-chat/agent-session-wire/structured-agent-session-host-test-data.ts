import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import type { AgentSessionExecutionLocation } from '../../../shared/agent-session-record'
import { journalDirectoryFor } from '../agent-session-journal/journal-paths'
import { openAgentSessionJournal } from '../agent-session-journal/journal-store'
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

export async function seedHostTestQuestionGroup(
  root: string
): Promise<{ itemId: string; revision: number }> {
  const journal = await openAgentSessionJournal({
    identity: {
      sessionId: HOST_TEST_SESSION,
      workspaceId: HOST_TEST_LOCATION.workspaceId,
      hostId: 'local',
      agent: 'codex',
      providerHandle: { kind: 'codex', threadId: HOST_TEST_THREAD }
    },
    journalDir: journalDirectoryFor(root, {
      workspaceId: HOST_TEST_LOCATION.workspaceId,
      sessionId: HOST_TEST_SESSION
    })
  })
  const appended = await journal.appendItem(
    { provider: 'codex', threadId: HOST_TEST_THREAD, turnId: 'turn-1', ordinal: 100 },
    {
      kind: 'question',
      question: '2 grouped questions',
      options: [],
      questions: [
        {
          id: 'q1',
          question: 'Targets?',
          options: [
            { id: 'q1:choice-1', label: 'Web' },
            { id: 'q1:choice-2', label: 'Mobile' }
          ],
          multiSelect: true,
          freeTextQuestionId: 'q1'
        },
        {
          id: 'q2',
          question: 'Mode?',
          options: [{ id: 'q2:choice-1', label: 'Safe' }],
          multiSelect: false,
          freeTextQuestionId: 'q2'
        }
      ],
      resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
    },
    { fence: 1 }
  )
  return { itemId: appended.itemId, revision: appended.revision }
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
