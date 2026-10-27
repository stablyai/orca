import type { AgentJournalItemBody } from '../../shared/agent-session-journal-types'
import { CODEX_COLLAB_ROW_AGENTS_KEY } from '../../shared/codex-collab-agent-tools'
import { journalPayload } from '../native-chat/agent-session-journal/journal-payload-bounds'
import {
  codexCollabHelperLabel,
  codexCollabToolName,
  readCodexCollabAgentToolCall,
  type CodexCollabAgentToolCall
} from './codex-collab-agent-tool-call'
import { readString } from './codex-item-field-readers'
import { codexItemRunState } from './codex-item-run-state'
import type { CodexThreadItem } from './codex-thread-item-identity'

export type CodexHelperName = (threadId: string) => string | null

function helperNames(call: CodexCollabAgentToolCall, helperName?: CodexHelperName): string {
  if (call.tool === 'spawnAgent') {
    const spawned = call.receiverThreadIds[0]
    return (spawned && helperName?.(spawned)) || codexCollabHelperLabel(call.prompt) || ''
  }
  return call.receiverThreadIds.map((threadId) => helperName?.(threadId) ?? threadId).join(', ')
}

/** Codex's own words for a helper's `CollabAgentStatus`, as its client shows them. */
const HELPER_STATUS_TEXT = new Map<string, string>([
  ['pendingInit', 'Pending init'],
  ['running', 'Running'],
  ['interrupted', 'Interrupted'],
  ['completed', 'Completed'],
  ['shutdown', 'Shutdown'],
  ['notFound', 'Not found']
])

const CALL_STATUS_TEXT = new Map<string, string>([
  ['completed', 'Completed'],
  ['failed', 'Failed'],
  ['interrupted', 'Interrupted']
])

type HelperState = CodexCollabAgentToolCall['states'][number]

function statusSummary(state: HelperState): string | null {
  if (state.status === 'errored') {
    return `Error - ${state.message ?? 'Agent errored'}`
  }
  if (state.status === 'completed' && state.message) {
    return `Completed - ${state.message}`
  }
  return state.status === null ? null : (HELPER_STATUS_TEXT.get(state.status) ?? state.status)
}

// Every finished call needs output to preserve result pairing on older desktop/mobile clients.
function outputText(call: CodexCollabAgentToolCall, helperName?: CodexHelperName): string | null {
  if (call.status === null || call.status === 'inProgress') {
    return null
  }
  // Spawn/close snapshots predate the action, so report the action instead.
  switch (call.tool) {
    case 'spawnAgent':
      return call.receiverThreadIds.length > 0 ? 'Spawned' : 'Agent spawn failed'
    case 'sendInput':
      return 'Sent input'
    case 'closeAgent':
      return 'Closed'
    case 'resumeAgent':
      return (call.states[0] && statusSummary(call.states[0])) ?? 'Error - Agent resume failed'
  }
  const reports = call.states.flatMap((state) => {
    const text =
      call.tool === 'wait' && state.status === 'completed' && state.message
        ? state.message
        : statusSummary(state)
    return text === null ? [] : [{ threadId: state.threadId, text }]
  })
  if (reports.length === 0) {
    // Timed-out waits and v2 wait completions can report no helper states.
    return call.tool === 'wait'
      ? 'Finished waiting'
      : (CALL_STATUS_TEXT.get(call.status) ?? call.status)
  }
  if (reports.length === 1 && call.receiverThreadIds.length === 1) {
    return reports[0].text
  }
  return reports
    .map(({ threadId, text }) => `${helperName?.(threadId) ?? threadId}: ${text}`)
    .join('\n')
}

function collabRowInput(fields: Record<string, unknown>, prompt: string | null): unknown {
  const input = prompt ? { ...fields, prompt } : fields
  return Object.keys(input).length > 0 ? input : null
}

export function codexCollabAgentToolCallBody(
  item: CodexThreadItem,
  helperName?: CodexHelperName,
  started?: CodexThreadItem
): AgentJournalItemBody | null {
  const call = readCodexCollabAgentToolCall(item, started)
  if (!call) {
    return null
  }
  const description = helperNames(call, helperName)
  const model = readString(item, 'model')
  const reasoningEffort = readString(item, 'reasoningEffort')
  const fields = {
    // Use the roster's helper name as the tool-row label.
    ...(description ? { description } : {}),
    ...(model ? { model } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(call.receiverThreadIds.length > 0
      ? { [CODEX_COLLAB_ROW_AGENTS_KEY]: call.receiverThreadIds }
      : {})
  }
  const text = outputText(call, helperName)
  return {
    kind: 'tool-call',
    name: codexCollabToolName(call),
    callId: call.id,
    input: collabRowInput(fields, call.prompt),
    state: codexItemRunState(item),
    ...(text === null ? {} : { output: journalPayload(text) })
  }
}
