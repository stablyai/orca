// A Codex `collabAgentToolCall` item → a tool row that names the helper it acted on.
//
// The row is the call the agent made (`spawn_agent`, `wait_agent`, `close_agent`, …); the helper
// itself is the subagent roster's row. A helper is named the way the roster names it, so the two
// rows read as the same child.

import type { AgentJournalItemBody } from '../../shared/agent-session-journal-types'
import { CODEX_COLLAB_ROW_AGENTS_KEY } from '../../shared/codex-collab-agent-tools'
import {
  boundInlineText,
  boundToolInput,
  DEFAULT_JOURNAL_PAYLOAD_LIMITS
} from '../native-chat/agent-session-journal/journal-payload-bounds'
import {
  codexCollabHelperLabel,
  codexCollabToolName,
  readCodexCollabAgentToolCall,
  type CodexCollabAgentToolCall
} from './codex-collab-agent-tool-call'
import { readString } from './codex-item-field-readers'
import { codexItemRunState } from './codex-item-run-state'
import type { CodexThreadItem } from './codex-thread-item-identity'

/** The roster's name for a helper thread, or null for one it holds no name for. */
export type CodexHelperName = (threadId: string) => string | null

/** Who the call acted on. A spawn names its helper by its prompt until the roster holds the
 *  thread it became; a helper with no name (its spawn was never seen) is named by its thread id. */
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

/** A helper's status summarised as Codex's own client does: a completed helper with its last
 *  reply, an errored one with its error. */
function statusSummary(state: HelperState): string | null {
  if (state.status === 'errored') {
    return `Error - ${state.message ?? 'Agent errored'}`
  }
  if (state.status === 'completed' && state.message) {
    return `Completed - ${state.message}`
  }
  return state.status === null ? null : (HELPER_STATUS_TEXT.get(state.status) ?? state.status)
}

/** A finished call's output, worded as Codex's own client words the call. Every finished call has
 *  one: a client that pairs results by position (one predating result call ids) would otherwise
 *  draw each later output in the run under the call before its own. The row label already names
 *  the helper, so the output does not. */
function outputText(call: CodexCollabAgentToolCall, helperName?: CodexHelperName): string | null {
  if (call.status === null || call.status === 'inProgress') {
    return null
  }
  // The status a spawn or close reports predates what it did (a closed helper reads `running`),
  // so these say what the call did.
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
    // A wait returns what each finished helper said.
    const text =
      call.tool === 'wait' && state.status === 'completed' && state.message
        ? state.message
        : statusSummary(state)
    return text === null ? [] : [{ threadId: state.threadId, text }]
  })
  if (reports.length === 0) {
    // A wait's end names only helpers that finished (none when it timed out; v2's never names any).
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

/** The prompt is clipped on its own: bounded with the rest, a long one would clip away the
 *  helper's name and ids the row is read by. */
function collabRowInput(fields: Record<string, unknown>, prompt: string | null): unknown {
  const bounded = boundToolInput(fields, DEFAULT_JOURNAL_PAYLOAD_LIMITS)
  if (bounded !== fields) {
    return bounded
  }
  const input = prompt
    ? { ...fields, prompt: boundInlineText(prompt, DEFAULT_JOURNAL_PAYLOAD_LIMITS).text }
    : fields
  return Object.keys(input).length > 0 ? input : null
}

/** `started` is the call's started item, when the caller still holds it. */
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
    // `description` is the key the row label reads, so the helper's name leads the row.
    ...(description ? { description } : {}),
    ...(model ? { model } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(call.receiverThreadIds.length > 0
      ? { [CODEX_COLLAB_ROW_AGENTS_KEY]: call.receiverThreadIds }
      : {})
  }
  const text = outputText(call, helperName)
  const output = text === null ? null : boundInlineText(text, DEFAULT_JOURNAL_PAYLOAD_LIMITS)
  return {
    kind: 'tool-call',
    name: codexCollabToolName(call),
    callId: call.id,
    input: collabRowInput(fields, call.prompt),
    state: codexItemRunState(item),
    ...(output === null ? {} : { output: output.bounded })
  }
}
