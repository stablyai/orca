import { CursorAcpPermissionCancellation } from './cursor-acp-permission-cancellation'
import { vi } from 'vitest'
import { CursorAcpPrompts } from './cursor-acp-prompts'
import type { CursorAcpConnection } from './cursor-acp-connection'
import type {
  AgentJournalItemIdentity,
  AgentJournalApprovalItem,
  AgentJournalQuestionItem
} from '../../shared/agent-session-journal-types'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'

export function cursorAcpPromptsFixture() {
  const connection: CursorAcpConnection = {
    pid: undefined,
    closed: false,
    capabilities: {},
    permissionCancellation: new CursorAcpPermissionCancellation(),
    request: vi.fn(),
    notify: vi.fn(),
    respond: vi.fn(),
    respondWithError: vi.fn(),
    close: vi.fn(async () => true)
  }
  const rows: {
    identity: AgentJournalItemIdentity
    body: AgentJournalApprovalItem | AgentJournalQuestionItem
  }[] = []
  const prompts = new CursorAcpPrompts(
    () => connection,
    () => 'owned-provider-id',
    (identity, body) => rows.push({ identity, body })
  )
  const permission = (optionIds = ['allow', 'reject']) =>
    prompts.receive({
      id: 'permission-id',
      method: 'session/request_permission',
      params: {
        sessionId: 'owned-provider-id',
        toolCall: { toolCallId: 'tool-1', title: 'Run fixture tool' },
        options: optionIds.map((optionId) => ({
          optionId,
          name: optionId,
          kind: optionId === 'reject' ? 'reject_once' : 'allow_once'
        }))
      }
    })
  const answer = (optionId = 'allow', commit = async () => {}) => {
    const row = rows[0]
    if (!row) {
      throw new Error('No fixture prompt')
    }
    return prompts.answer({
      sessionId: 'orca-session',
      fence: 7,
      itemId: agentJournalItemKey(row.identity),
      kind: row.body.kind,
      response: { kind: 'option', optionId },
      commit
    })
  }
  return { connection, rows, prompts, permission, answer }
}
