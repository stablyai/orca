import type { AgentSessionAccountKind } from '../../../../shared/agent-session/agent-session-availability'
import type { AgentJournalMessageItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionExecutionOptions } from '../../../../shared/agent-session/options/protocol/agent-session-execution-options'
import type { StructuredAgentSessionAdmitFreshInput } from '../../../native-chat/agent-session-wire/delivery/structured-agent-session-input-admission'
import type { CodexAppServerConnection } from '../../app-server/codex-app-server-connection-types'
import type { CodexSkillReport } from '../catalog/codex-structured-skill-report'
import type { CodexSession } from '../session-lifecycle/codex-structured-session-state'
import type { CodexDispatchEchoes } from './codex-structured-dispatch-echo'
import type { CodexTurnOpenWaits } from './codex-structured-turn-open-wait'

export type CodexTurnHost = {
  account?: AgentSessionAccountKind
  skillReport?: Pick<CodexSkillReport, 'hasSkillPath'>
  connection: Pick<CodexAppServerConnection, 'request'>
  threadId: string
  permissions?: CodexSession['permissions']
  options: Map<string, string>
  appliedTurnOptions?: Readonly<Record<string, string>>
  appliedTurnInputOptions?: Readonly<Record<string, string>>
  appliedSettings?: CodexSession['appliedSettings']
  reportedOptions?: CodexSession['reportedOptions']
  catalogAccess?: CodexSession['catalogAccess']
  dispatchEchoes: CodexDispatchEchoes
  activeTurnIds?: ReadonlySet<string>
  /** Running turns whose interrupt Codex already answered: aborted, so never steered. */
  abortedTurnIds?: ReadonlySet<string>
  turnOpenWaits: Pick<CodexTurnOpenWaits, 'wait'>
}

export type CodexTurnInput = {
  clientMessageId: string
  body: AgentJournalMessageItem
  requestedAt?: number
  turnOptions?: Readonly<Record<string, string>>
  executionOptions?: AgentSessionExecutionOptions
  signal?: AbortSignal
  isCurrent?: () => boolean
  admitFreshInput?: StructuredAgentSessionAdmitFreshInput
}
