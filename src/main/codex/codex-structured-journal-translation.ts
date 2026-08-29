import type { AgentJournalItemIdentity } from '../../shared/agent-session-journal-types'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import type { AgentSessionDeltaCoalescerDeps } from '../native-chat/agent-session-wire/agent-session-delta-coalescer'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { unhandledProviderFrameJournalItem } from '../native-chat/agent-session-wire/unhandled-provider-frame'
import type { CodexStructuredSessionEvent } from './codex-structured-session-adapter'
import {
  codexItemIdentity,
  codexJournalItem,
  CodexTurnOrdinals,
  readCodexThreadItem
} from './codex-structured-item-translation'
import {
  codexStructuredItemKey,
  createCodexStructuredItemStreams
} from './codex-structured-item-streams'
import {
  codexApprovalItem,
  codexPromptIdentity,
  codexQuestionItems
} from './codex-structured-prompt-items'
import { CODEX_USER_INPUT_METHOD } from './codex-structured-prompt-replies'
import { readCodexTurnId } from './codex-structured-thread-facts'

// The one place Codex events become journal rows.
//
// Every durable decision lives here rather than in the adapter: the adapter
// knows the protocol, this knows what a user is owed after a reconnect. It is
// per-session and per-acquisition — a new lease gets a new translator and a new
// sink, so a superseded child cannot keep writing.

export const MAX_CODEX_GENERIC_ROWS_PER_TURN = 8

export type CodexJournalTranslatorDeps = {
  sink: StructuredAgentSessionEventSink
  /** Points an answered journal item back at the live Codex request. */
  bindPromptItemId?: (journalItemId: string, threadId: string, promptKey: string) => void
  primaryThreadId?: () => string | null
  coalesceMs?: number
  schedule?: AgentSessionDeltaCoalescerDeps['schedule']
}

export type CodexJournalTranslator = {
  handle: (event: CodexStructuredSessionEvent) => void
  restoreThread: (threadId: string, thread: Record<string, unknown>) => void
  flush: () => void
  dispose: () => void
}

function readRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

export function createCodexJournalTranslator(
  deps: CodexJournalTranslatorDeps
): CodexJournalTranslator {
  const ordinals = new CodexTurnOrdinals()
  /** Identity assigned when an item was announced, reused by its deltas and by
   *  its completion so all three upsert one row. */
  const identities = new Map<string, AgentJournalItemIdentity>()
  /** What each announced item is, so an approval can name what it approves. */
  const details = new Map<string, string>()
  /** Turns announced by the provider and not yet closed. */
  const currentTurnIds = new Map<string, Set<string>>()
  const genericRowsByTurn = new Map<string, number>()
  const suppressedRowsByTurn = new Map<string, number>()
  let fallbackSequence = 0

  const currentTurnIdFor = (threadId: string): string | null =>
    [...(currentTurnIds.get(threadId) ?? [])].at(-1) ?? null

  const rememberTurn = (threadId: string, turnId: string): void => {
    currentTurnIds.set(threadId, new Set([...(currentTurnIds.get(threadId) ?? []), turnId]))
  }

  const forgetTurn = (threadId: string, turnId: string): void => {
    const active = currentTurnIds.get(threadId)
    active?.delete(turnId)
    if (!active?.size) {
      currentTurnIds.delete(threadId)
    }
  }

  const appendUnhandled = (kind: string, payload: unknown, threadId = 'session'): void => {
    const translated = unhandledProviderFrameJournalItem('codex', kind, payload)
    if (!translated) {
      return
    }
    const turnId = readCodexTurnId(payload) ?? currentTurnIdFor(threadId) ?? 'outside-turn'
    const bucket = `${encodeURIComponent(threadId)}:${encodeURIComponent(turnId)}`
    const rowCount = genericRowsByTurn.get(bucket) ?? 0
    // The cap bounds noise, never evidence: an error frame is always journaled,
    // and capped frames stay countable through one summary row per turn.
    const capped =
      rowCount >= MAX_CODEX_GENERIC_ROWS_PER_TURN && translated.classification !== 'error-surface'
    if (capped) {
      const suppressed = (suppressedRowsByTurn.get(bucket) ?? 0) + 1
      suppressedRowsByTurn.set(bucket, suppressed)
      deps.sink.appendItem(
        { provider: 'orca', clientMessageId: `provider-frame-suppressed:codex:${bucket}` },
        {
          kind: 'status',
          text: `${suppressed} more provider notification${suppressed === 1 ? '' : 's'} not shown for this turn`
        }
      )
      deps.sink.publish()
      return
    }
    genericRowsByTurn.set(bucket, rowCount + 1)
    fallbackSequence += 1
    deps.sink.appendItem(
      { provider: 'orca', clientMessageId: `provider-frame:codex:${fallbackSequence}` },
      translated.body,
      translated.blobs
    )
    deps.sink.publish()
  }

  const publishTurnLifecycle = (
    sessionId: string,
    threadId: string,
    turnId: string,
    state: 'running' | 'completed'
  ): void => {
    if (deps.primaryThreadId?.() !== threadId) {
      return
    }
    const identity = {
      provider: 'legacy' as const,
      agent: 'codex' as const,
      sessionId,
      recordId: `turn-lifecycle:${turnId}`
    }
    if (state === 'completed') {
      deps.sink.appendTombstone(identity)
    } else {
      deps.sink.appendItem(identity, {
        kind: 'status',
        text: 'Codex is working…',
        turnLifecycle: { turnId, state }
      })
    }
    deps.sink.publish()
  }

  const identityFor = (
    threadId: string,
    turnId: string | null,
    item: { type: string; id: string }
  ): AgentJournalItemIdentity => {
    const key = codexStructuredItemKey(threadId, item.id)
    const existing = identities.get(key)
    if (existing) {
      return existing
    }
    const identity = codexItemIdentity({ threadId, turnId, item, ordinals })
    identities.set(key, identity)
    return identity
  }

  const streams = createCodexStructuredItemStreams({
    sink: deps.sink,
    coalesceMs: deps.coalesceMs,
    schedule: deps.schedule,
    identityFor: (threadId, params, item) => {
      const turnId = readCodexTurnId(params) ?? currentTurnIdFor(threadId)
      return identityFor(threadId, turnId, item)
    }
  })

  const handleItemEvent = (event: {
    threadId: string
    method: string
    params: unknown
  }): boolean => {
    const params = readRecord(event.params)
    const item = readCodexThreadItem(params.item)
    if (!item) {
      return false
    }
    const turnId = readCodexTurnId(event.params) ?? currentTurnIdFor(event.threadId)
    const identity = identityFor(event.threadId, turnId, item)
    const translated = codexJournalItem(item)
    const command = readString(item, 'command')
    if (command) {
      details.set(codexStructuredItemKey(event.threadId, item.id), command)
    }
    if (event.method === 'item/completed') {
      // The completed body is authoritative; the coalesced text is now stale.
      streams.forget(event.threadId, item.id)
    } else {
      streams.track(event.threadId, item, identity)
    }
    if (!translated.body) {
      return true
    }
    deps.sink.appendItem(identity, translated.body, translated.blobs)
    deps.sink.publish()
    return true
  }

  // The row is keyed by the prompt and the announced command is looked up by the
  // tool item, because one item can ask more than once.
  const handlePrompt = (event: {
    threadId: string
    method: string
    params: unknown
    codexItemId: string
    promptKey: string
  }): void => {
    if (event.method === CODEX_USER_INPUT_METHOD) {
      for (const question of codexQuestionItems({
        threadId: event.threadId,
        promptKey: event.promptKey,
        params: event.params
      })) {
        deps.sink.appendItem(question.identity, question.body)
        deps.bindPromptItemId?.(
          agentJournalItemKey(question.identity),
          event.threadId,
          event.promptKey
        )
      }
      deps.sink.publish()
      return
    }
    const identity = codexPromptIdentity({
      threadId: event.threadId,
      promptKey: event.promptKey
    })
    deps.sink.appendItem(
      identity,
      codexApprovalItem({
        method: event.method,
        params: event.params,
        detail: details.get(codexStructuredItemKey(event.threadId, event.codexItemId)) ?? null
      })
    )
    deps.bindPromptItemId?.(agentJournalItemKey(identity), event.threadId, event.promptKey)
    deps.sink.publish()
  }

  return {
    restoreThread: (threadId, thread) => {
      const turns = Array.isArray(thread.turns) ? thread.turns : []
      for (const rawTurn of turns) {
        const turn = readRecord(rawTurn)
        const turnId = readString(turn, 'id')
        if (!turnId) {
          continue
        }
        currentTurnIds.set(threadId, new Set([turnId]))
        for (const item of Array.isArray(turn.items) ? turn.items : []) {
          handleItemEvent({ threadId, method: 'item/completed', params: { turnId, item } })
        }
        currentTurnIds.delete(threadId)
        ordinals.forgetTurn(threadId, turnId)
      }
      streams.flush()
    },
    handle: (event) => {
      if (event.type === 'ended') {
        streams.flush()
        for (const [threadId, turnIds] of currentTurnIds) {
          for (const turnId of turnIds) {
            publishTurnLifecycle(event.sessionId, threadId, turnId, 'completed')
            ordinals.forgetTurn(threadId, turnId)
          }
        }
        currentTurnIds.clear()
        return
      }
      if (
        event.type === 'notification' &&
        streams.handle(event.threadId, event.method, event.params)
      ) {
        return
      }
      // Lifecycle bypass: nothing may be journaled ahead of the text it follows.
      streams.flush()
      if (event.type === 'prompt') {
        handlePrompt(event)
        return
      }
      if (event.type === 'server-request') {
        appendUnhandled(`request:${event.method}`, event.params, event.threadId)
        return
      }
      if (event.type === 'provider-frame') {
        appendUnhandled(event.kind, event.payload, event.threadId)
        return
      }
      if (event.method === 'turn/started') {
        const turnId = readCodexTurnId(event.params)
        if (turnId) {
          rememberTurn(event.threadId, turnId)
          publishTurnLifecycle(event.sessionId, event.threadId, turnId, 'running')
        }
        return
      }
      if (event.method === 'turn/completed') {
        const turnId = readCodexTurnId(event.params) ?? currentTurnIdFor(event.threadId)
        if (turnId) {
          publishTurnLifecycle(event.sessionId, event.threadId, turnId, 'completed')
          ordinals.forgetTurn(event.threadId, turnId)
          forgetTurn(event.threadId, turnId)
        }
        // A later item without its own turn id falls back to another active
        // turn, if one exists; completed turns are never adopted again.
        return
      }
      if (event.method === 'item/started' || event.method === 'item/completed') {
        if (!handleItemEvent(event)) {
          appendUnhandled(`notification:${event.method}`, event.params, event.threadId)
        }
        return
      }
      appendUnhandled(`notification:${event.method}`, event.params, event.threadId)
    },
    flush: streams.flush,
    dispose: () => {
      streams.dispose()
      identities.clear()
      details.clear()
      currentTurnIds.clear()
      genericRowsByTurn.clear()
      suppressedRowsByTurn.clear()
    }
  }
}
