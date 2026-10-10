import { AGENT_JOURNAL_THREAD_SCOPE } from '../../shared/agent-session-journal-types'
// Shared fixtures and the sink harness the background-task row suites drive.
//
// Moved out of claude-background-task-rows.test.ts verbatim when that suite
// reached its line budget, so the terminal-frame suite reads the same captured
// payloads and the same forwarded-tool admission set rather than a second copy.

import { vi } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity
} from '../../shared/agent-session-journal-types'
import type { NativeChatBackgroundTaskBlock } from '../../shared/native-chat-types'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { ClaudeBackgroundTaskRows } from './claude-background-task-rows'

/** The exact payloads the user's journal carried for the reported failure. */
export const FAILED_UPDATE = {
  type: 'system',
  subtype: 'task_updated',
  task_id: 'byjnee2no',
  patch: { status: 'failed', end_time: 1_789_332_035_695 }
}
export const FAILED_NOTIFICATION = {
  type: 'system',
  subtype: 'task_notification',
  task_id: 'byjnee2no',
  tool_use_id: 'toolu_01CqPd7y',
  status: 'failed',
  output_file: '/private/tmp/claude-501/tasks/byjnee2no.output',
  summary: 'Background command "Wait for the verification verdict" failed with exit code 1'
}

/** A terminal frame captured from a user session whose task was never admitted.
 *  Nothing rendered for it: the typed path declined the row and told the generic
 *  fallback the frame was covered. */
export const ORPHAN_FAILED_NOTIFICATION = {
  type: 'system',
  subtype: 'task_notification',
  task_id: 'bjzenpq13',
  tool_use_id: 'toolu_01ASNfnDBEzt4w3ejLE12bGu',
  status: 'failed',
  output_file: '',
  summary: 'Locate the exact screenshot session',
  uuid: '1d748563-5741-4aa8-9c21-7023b90bc737',
  session_id: 'f4579b9c-b4bb-4551-81b2-2acca35e4a7b'
}

export function blockOf(
  body: AgentJournalItemBody | undefined
): NativeChatBackgroundTaskBlock | null {
  if (!body || body.kind !== 'message') {
    return null
  }
  const block = body.blocks.find(
    (candidate): candidate is NativeChatBackgroundTaskBlock => candidate.type === 'background-task'
  )
  return block ?? null
}

export function twinOf(body: AgentJournalItemBody | undefined): string | null {
  if (!body || body.kind !== 'message') {
    return null
  }
  const block = body.blocks.find((candidate) => candidate.type === 'text')
  return block?.type === 'text' ? block.text : null
}

/** The spawn call the harness treats as forwarded to the top-level transcript.
 *  Admission consults this, so a test that wants a row must name it. */
export const FORWARDED_TOOL = 'toolu_01CqPd7y'

export function harness(
  forwarded: readonly string[] = [FORWARDED_TOOL, 'toolu_first', 'toolu_second']
) {
  const items: { identity: AgentJournalItemIdentity; body: AgentJournalItemBody }[] = []
  const turnOpens: number[] = []
  const sink: StructuredAgentSessionEventSink = {
    appendItem: (identity, body) => items.push({ identity, body }),
    appendTombstone: vi.fn(),
    publish: vi.fn()
  }
  let clock = 1_000
  const forwardedTools = new Set(forwarded)
  const rows = new ClaudeBackgroundTaskRows({
    sink,
    isForwardedParentTool: (toolUseId) => forwardedTools.has(toolUseId),
    openOutputTurn: () => turnOpens.push(1),
    now: () => (clock += 10),
    turnScope: () => AGENT_JOURNAL_THREAD_SCOPE
  })
  const keys = (): string[] =>
    items.map((item) =>
      item.identity.provider === 'orca' ? item.identity.clientMessageId : item.identity.provider
    )
  return {
    rows,
    items,
    keys,
    forwardedTools,
    latest: () => blockOf(items.at(-1)?.body),
    latestTwin: () => twinOf(items.at(-1)?.body),
    turnOpens
  }
}

export const START_BASH = {
  type: 'system',
  subtype: 'task_started',
  task_id: 'byjnee2no',
  tool_use_id: 'toolu_01CqPd7y',
  task_type: 'local_bash',
  description: 'Wait for the verification verdict',
  is_backgrounded: true
}
