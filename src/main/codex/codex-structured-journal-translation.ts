import type { AgentJournalItemIdentity } from '../../shared/agent-session-journal-types'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import {
  createAgentSessionDeltaCoalescer,
  type AgentSessionDeltaCoalescerDeps
} from '../native-chat/agent-session-wire/agent-session-delta-coalescer'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { unhandledProviderFrameJournalItem } from '../native-chat/agent-session-wire/unhandled-provider-frame'
import type { CodexStructuredSessionEvent } from './codex-structured-session-adapter'
import {
  codexItemIdentity,
  codexJournalItem,
  codexStreamingMessageBody,
  CodexTurnOrdinals,
  readCodexThreadItem
} from './codex-structured-item-translation'
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

const AGENT_MESSAGE_DELTA_METHOD = 'item/agentMessage/delta'

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
  const currentTurnIds = new Map<string, string>()
  const latestStreamText = new Map<string, string>()
  const checkpointLengths = new Map<string, number>()
  let fallbackSequence = 0

  const appendUnhandled = (kind: string, payload: unknown): void => {
    const translated = unhandledProviderFrameJournalItem('codex', kind, payload)
    if (!translated) {
      return
    }
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

  const itemKey = (threadId: string, codexItemId: string): string =>
    `${encodeURIComponent(threadId)}:${encodeURIComponent(codexItemId)}`

  const persistStream = (key: string, text: string, force: boolean): void => {
    latestStreamText.set(key, text)
    const checkpointLength = checkpointLengths.get(key) ?? 0
    const nextLength = Math.max(checkpointLength + 32, Math.ceil(checkpointLength * 1.125))
    if (!force && checkpointLength > 0 && text.length < nextLength) {
      return
    }
    checkpointLengths.set(key, text.length)
    const identity = identities.get(key)
    if (!identity) {
      return
    }
    deps.sink.appendItem(identity, codexStreamingMessageBody(text))
    deps.sink.publish()
  }

  const persistLatestStreams = (): void => {
    for (const [key, text] of latestStreamText) {
      if (checkpointLengths.get(key) !== text.length) {
        persistStream(key, text, true)
      }
    }
  }

  const flushStreams = (): void => {
    coalescer.flushAll()
    persistLatestStreams()
  }

  const coalescer = createAgentSessionDeltaCoalescer({
    windowMs: deps.coalesceMs,
    schedule: deps.schedule,
    emit: (key, text) => {
      persistStream(key, text, false)
    }
  })

  const identityFor = (
    threadId: string,
    turnId: string | null,
    item: { type: string; id: string }
  ): AgentJournalItemIdentity => {
    const key = itemKey(threadId, item.id)
    const existing = identities.get(key)
    if (existing) {
      return existing
    }
    const identity = codexItemIdentity({ threadId, turnId, item, ordinals })
    identities.set(key, identity)
    return identity
  }

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
    const turnId = readCodexTurnId(event.params) ?? currentTurnIds.get(event.threadId) ?? null
    const identity = identityFor(event.threadId, turnId, item)
    const translated = codexJournalItem(item)
    const command = readString(item, 'command')
    if (command) {
      details.set(itemKey(event.threadId, item.id), command)
    }
    if (event.method === 'item/completed') {
      // The completed body is authoritative; the coalesced text is now stale.
      coalescer.forget(itemKey(event.threadId, item.id))
      latestStreamText.delete(itemKey(event.threadId, item.id))
      checkpointLengths.delete(itemKey(event.threadId, item.id))
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
        detail: details.get(itemKey(event.threadId, event.codexItemId)) ?? null
      })
    )
    deps.bindPromptItemId?.(agentJournalItemKey(identity), event.threadId, event.promptKey)
    deps.sink.publish()
  }

  return {
    handle: (event) => {
      if (event.type === 'ended') {
        flushStreams()
        for (const [threadId, turnId] of currentTurnIds) {
          publishTurnLifecycle(event.sessionId, threadId, turnId, 'completed')
        }
        currentTurnIds.clear()
        return
      }
      if (event.type === 'notification' && event.method === AGENT_MESSAGE_DELTA_METHOD) {
        const params = readRecord(event.params)
        const codexItemId = readString(params, 'itemId')
        const delta = params.delta
        if (codexItemId && typeof delta === 'string') {
          coalescer.append(itemKey(event.threadId, codexItemId), delta)
        } else {
          appendUnhandled(`notification:${event.method}`, event.params)
        }
        return
      }
      // Lifecycle bypass: nothing may be journaled ahead of the text it follows.
      flushStreams()
      if (event.type === 'prompt') {
        handlePrompt(event)
        return
      }
      if (event.type === 'server-request') {
        appendUnhandled(`request:${event.method}`, event.params)
        return
      }
      if (event.type === 'provider-frame') {
        appendUnhandled(event.kind, event.payload)
        return
      }
      if (event.method === 'turn/started') {
        const turnId = readCodexTurnId(event.params)
        if (turnId) {
          currentTurnIds.set(event.threadId, turnId)
          publishTurnLifecycle(event.sessionId, event.threadId, turnId, 'running')
        }
        return
      }
      if (event.method === 'turn/completed') {
        const turnId = readCodexTurnId(event.params) ?? currentTurnIds.get(event.threadId)
        if (turnId) {
          publishTurnLifecycle(event.sessionId, event.threadId, turnId, 'completed')
        }
        // A later item with no turn of its own belongs to no turn, not to the
        // one that just ended.
        currentTurnIds.delete(event.threadId)
        return
      }
      if (event.method === 'item/started' || event.method === 'item/completed') {
        if (!handleItemEvent(event)) {
          appendUnhandled(`notification:${event.method}`, event.params)
        }
        return
      }
      appendUnhandled(`notification:${event.method}`, event.params)
    },
    flush: flushStreams,
    dispose: () => {
      coalescer.dispose()
      identities.clear()
      details.clear()
      currentTurnIds.clear()
      latestStreamText.clear()
      checkpointLengths.clear()
    }
  }
}
