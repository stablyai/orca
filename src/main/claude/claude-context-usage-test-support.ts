// A translator over an in-memory journal, for tests of the context facts it writes.

import { vi } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity,
  AgentJournalRenderItem
} from '../../shared/agent-session-journal-types'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import type {
  StructuredAgentSessionEventSink,
  StructuredAgentSessionRevisionJournal
} from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import type { ClaudeContextReportTarget } from './claude-context-facts'
import { createClaudeJournalTranslator } from './claude-structured-journal-translation'
import { claudeTurnLifecycleIdentity } from './claude-turn-lifecycle-item'

/** A journal in miniature: the latest revision per row, its creation clock
 *  pinned, and revisions resolved against it as a bound sink would. */
export function journal() {
  const clock = { now: 0 }
  const appends: { identity: AgentJournalItemIdentity; body: AgentJournalItemBody }[] = []
  const rows = new Map<string, AgentJournalRenderItem>()
  const appendItem: StructuredAgentSessionEventSink['appendItem'] = (identity, body, options) => {
    appends.push({ identity, body })
    const itemId = agentJournalItemKey(identity)
    const existing = rows.get(itemId)
    rows.set(itemId, {
      itemId,
      revision: (existing?.revision ?? 0) + 1,
      sequence: existing?.sequence ?? rows.size + 1,
      observedAt: existing?.observedAt ?? options?.observedAt ?? clock.now,
      body
    })
  }
  const scans = { count: 0 }
  const bound: StructuredAgentSessionRevisionJournal = {
    epoch: 'test',
    visitItems: (visit) => {
      scans.count += 1
      for (const row of rows.values()) {
        visit(row.itemId, row.sequence, row.body)
      }
    },
    itemBody: (itemId) => rows.get(itemId)?.body ?? null
  }
  const revise: NonNullable<StructuredAgentSessionEventSink['tryReviseResolvedItem']> = (
    _reservedBytes,
    resolve,
    options
  ) => {
    const resolved = resolve(bound)
    if (resolved) {
      appendItem(resolved.identity, resolved.body, options)
    }
    return { accepted: true }
  }
  const sink: StructuredAgentSessionEventSink = {
    appendItem,
    tryReviseResolvedItem: revise,
    tryReviseResolvedItemAndPublish: revise,
    appendTombstone: () => {},
    publish: vi.fn()
  }
  const turnRow = (turnId: string) =>
    rows.get(agentJournalItemKey(claudeTurnLifecycleIdentity('claude-session', turnId)))
  const items = () => [...rows.values()].sort((left, right) => left.sequence - right.sequence)
  return { sink, clock, appends, rows, turnRow, items, scans }
}

export function frame(message: Record<string, unknown>, observedAt: number, startsTurn = false) {
  return {
    type: 'message' as const,
    sessionId: 'orca-session',
    observedAt,
    ...(startsTurn ? { startsTurn: true as const } : {}),
    message: { session_id: 'claude-session', parent_tool_use_id: null, ...message }
  }
}

export const userFrame = (uuid: string, at: number) =>
  frame(
    { type: 'user', uuid, message: { role: 'user', content: [{ type: 'text', text: 'go' }] } },
    at,
    true
  )

export function assistantFrame(
  uuid: string,
  at: number,
  input: number,
  parentToolUseId?: string,
  model = 'claude-fable-5-1',
  content: unknown[] = [{ type: 'text', text: uuid }]
) {
  return frame(
    {
      type: 'assistant',
      uuid,
      ...(parentToolUseId ? { parent_tool_use_id: parentToolUseId } : {}),
      message: {
        role: 'assistant',
        model,
        content,
        usage: {
          input_tokens: input,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          output_tokens: 4
        }
      }
    },
    at
  )
}

export const resultFrame = (at: number, modelUsage: Record<string, unknown> = {}) =>
  frame(
    {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'done',
      duration_ms: 10,
      uuid: `result-${at}`,
      modelUsage
    },
    at
  )

export const initFrame = (model: string, at: number) =>
  frame({ type: 'system', subtype: 'init', uuid: `init-${at}`, model }, at)

export const compactBoundary = (at: number) =>
  frame(
    {
      type: 'system',
      subtype: 'compact_boundary',
      uuid: `compact-${at}`,
      compact_metadata: { trigger: 'auto', pre_tokens: 150_000 }
    },
    at
  )

export const turnIdentity = (turnId: string) =>
  claudeTurnLifecycleIdentity('claude-session', turnId)

/** Every turn the CLI runs opens with an init naming the main model as `modelUsage` keys it. */
export function setup({ init = 'claude-fable-5-1[1m]' }: { init?: string | null } = {}) {
  const state = journal()
  const translator = createClaudeJournalTranslator({ sink: state.sink, coalesceMs: 0 })
  const requests: ClaudeContextReportTarget[] = []
  translator.subscribeContextUsageRequests((target) => requests.push(target))
  const handle = (event: Parameters<typeof translator.handle>[0]): void => {
    state.clock.now = event.type === 'message' ? (event.observedAt ?? 0) : 0
    translator.handle(event)
  }
  if (init) {
    handle(initFrame(init, 500))
  }
  return { ...state, translator, requests, handle }
}
