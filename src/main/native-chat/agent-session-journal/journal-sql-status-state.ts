import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { StructuredAgentSessionWorkScope } from '../../../shared/agent-session/view/structured-agent-session-main-agent-working'
import { isStructuredAgentSessionMainAgentWorking } from '../../../shared/agent-session/view/structured-agent-session-main-agent-working'
import { activeStructuredAgentSessionTurnId } from '../../../shared/agent-session/view/structured-agent-session-live-turn'
import { readAgentJournalTurn } from '../../../shared/agent-session/lifecycle/records/agent-session-turn-record'
import {
  isStructuredAgentSessionToolAction,
  structuredAgentSessionToolCallBlock
} from '../../../shared/agent-session/structured-agent-session-tool-call-block'
import { nativeChatStatusRequestOutcome } from '../../../shared/native-chat/native-chat-orca-stop-cut'
import { structuredAgentSessionStatusStartedAt } from '../../../shared/agent-session/view/structured-agent-session-status-started-at'
import {
  AGENT_STATUS_TOOL_INPUT_MAX_LENGTH,
  normalizeOptionalField
} from '../../../shared/agent-status/contracts/agent-status-field-normalization'
import { AGENT_STATUS_TOOL_NAME_MAX_LENGTH } from '../../../shared/agent-status/contracts/agent-status-types'
import { describeToolInput } from '../../../shared/native-chat/tools/native-chat-tool-summary'
import type { JournalSqlStatusContext } from './journal-sql-status-context'
import { readJournalSqlOrcaStopCut } from './journal-sql-status-cuts'
import { readJournalSqlRequestStatus } from './journal-sql-status-requests'

export type { JournalStatusState } from './journal-status-state'
import type { JournalStatusState } from './journal-status-state'

/** Compose named facts in one snapshot; scope remains the caller's live execution authority. */
export function readJournalSqlStatusState(
  state: JournalSqlStatusContext,
  currentFence?: number | null,
  scope?: StructuredAgentSessionWorkScope
): JournalStatusState {
  const requests = readJournalSqlRequestStatus(state, currentFence)
  if (!requests.hasRequest) {
    return {
      summary: { status: null, latestPrompt: '' },
      latestRequest: null,
      owesWork: false,
      pendingPromptIds: []
    }
  }
  const selects = state.select
  const floor = selects({ kind: 'clear' })[Symbol.iterator]().next().value?.item.sequence ?? 0
  const pending = [...selects({ kind: 'pending-prompts', floor })].flatMap(({ item }) => {
    const displayed = state.displayed(item.itemId)
    return displayed ? [displayed] : []
  })
  const actionable = pending.filter((item) => !scope || scope.isCurrentItem(item.itemId))
  const boundary = selects({ kind: 'boundary' })[Symbol.iterator]().next().value
  const currentBoundary =
    boundary && (!floor || boundary.item.sequence > floor) ? boundary : undefined
  const active = activeStructuredAgentSessionTurnId(
    currentBoundary ? [currentBoundary.item] : [],
    scope && ((item) => scope.isCurrentItem(item.itemId))
  )
  const submissions = state
    .statusInputs()
    .filter((send) => !floor || (send.acceptedSequence ?? 0) > floor)
  const owesWork = isStructuredAgentSessionMainAgentWorking(
    active,
    submissions,
    currentFence,
    scope
  )
  const status = actionable.length > 0 ? 'attention' : owesWork ? 'working' : 'idle'
  let tool: AgentJournalRenderItem | null = null
  if (
    status === 'working' &&
    currentBoundary &&
    readAgentJournalTurn(currentBoundary.item.body)?.state === 'running'
  ) {
    const selected =
      selects({ kind: 'tools', after: currentBoundary.position, running: true })
        [Symbol.iterator]()
        .next().value ??
      selects({ kind: 'tools', after: currentBoundary.position })[Symbol.iterator]().next().value
    tool = selected ? state.displayed(selected.item.itemId) : null
  }
  const block =
    tool && isStructuredAgentSessionToolAction(tool.body)
      ? structuredAgentSessionToolCallBlock(tool.body, tool.itemId)
      : null
  const toolName = block
    ? normalizeOptionalField(block.name, AGENT_STATUS_TOOL_NAME_MAX_LENGTH)
    : undefined
  const toolInput = block
    ? normalizeOptionalField(describeToolInput(block.input), AGENT_STATUS_TOOL_INPUT_MAX_LENGTH)
    : undefined
  const request = status === 'idle' ? requests.latestRequest : null
  const turnOutcome = nativeChatStatusRequestOutcome(
    request,
    request ? readJournalSqlOrcaStopCut(state, floor) : null
  )
  const latestTurn =
    status === 'working'
      ? selects({ kind: 'turns', floor })[Symbol.iterator]().next().value?.item
      : undefined
  const timestampItems = status === 'attention' ? pending : latestTurn ? [latestTurn] : []
  const statusStartedAt = structuredAgentSessionStatusStartedAt(
    status,
    timestampItems,
    submissions,
    currentFence,
    request
  )
  return {
    latestRequest: requests.latestRequest,
    owesWork: status !== 'idle' && owesWork,
    pendingPromptIds: status === 'attention' ? actionable.map((item) => item.itemId) : [],
    summary: {
      status,
      latestPrompt: requests.latestPrompt,
      ...(toolName ? { toolName } : {}),
      ...(toolInput ? { toolInput } : {}),
      ...(requests.lastAssistantMessage
        ? { lastAssistantMessage: requests.lastAssistantMessage }
        : {}),
      ...(turnOutcome ? { turnOutcome } : {}),
      ...(statusStartedAt !== undefined ? { statusStartedAt } : {})
    }
  }
}
