import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity
} from '../../shared/agent-session-journal-types'
import { requiresTerminalSettlement } from '../native-chat/agent-session-journal/journal-lifecycle-capacity'
import {
  codexItemIdentity,
  codexJournalItem,
  CodexTurnOrdinals,
  readCodexThreadItem,
  type CodexThreadItem
} from './codex-structured-item-translation'
import { createCodexStructuredItemStreams } from './codex-structured-item-streams'
import { codexStructuredItemKey } from './codex-structured-item-stream-bounds'
import type {
  CodexItemTranslation,
  CodexJournalTranslationAdmission,
  CodexJournalTranslatorDeps
} from './codex-structured-journal-contracts'
import { CODEX_JOURNAL_ADMITTED } from './codex-structured-journal-contracts'
import {
  MAX_CODEX_ACTIVE_ITEMS,
  MAX_CODEX_DETAIL_BYTES,
  MAX_CODEX_DETAIL_ENTRIES,
  MAX_CODEX_IDENTITY_ENTRIES
} from './codex-structured-journal-limits'
import { appendCodexLifecycleItem, publishCodexLifecycle } from './codex-structured-journal-sink'
import type { CodexActiveJournalItem } from './codex-structured-journal-settlement'
import { readCodexJournalString } from './codex-structured-journal-translation-values'
import { readCodexTurnId } from './codex-structured-thread-facts'

export class CodexJournalItems {
  readonly ordinals = new CodexTurnOrdinals()
  readonly activeItems = new Map<string, CodexActiveJournalItem>()
  readonly streams
  private readonly identities = new Map<string, AgentJournalItemIdentity>()
  private readonly details = new Map<string, string>()

  constructor(
    private readonly deps: Pick<
      CodexJournalTranslatorDeps,
      'sink' | 'coalesceMs' | 'maxRetainedBytes' | 'schedule'
    >,
    private readonly activeTurn: (threadId: string) => string | null,
    private readonly suppress: (threadId: string, turnId: string) => void
  ) {
    this.streams = createCodexStructuredItemStreams({
      sink: deps.sink,
      coalesceMs: deps.coalesceMs,
      maxRetainedBytes: deps.maxRetainedBytes,
      schedule: deps.schedule,
      identityFor: (threadId, params, item) => {
        const turnId = readCodexTurnId(params) ?? this.activeTurn(threadId)
        return this.identityFor(threadId, turnId, item)
      }
    })
  }

  detailFor(threadId: string, itemId: string): string | null {
    return this.details.get(codexStructuredItemKey(threadId, itemId)) ?? null
  }

  handle(event: { threadId: string; method: string; params: unknown }): CodexItemTranslation {
    const params =
      typeof event.params === 'object' && event.params !== null
        ? (event.params as Record<string, unknown>)
        : {}
    const item = readCodexThreadItem(params.item)
    if (!item) {
      return { handled: false }
    }
    const turnId = readCodexTurnId(event.params) ?? this.activeTurn(event.threadId)
    const identity = this.identityFor(event.threadId, turnId, item)
    const translated = codexJournalItem(item)
    const command = readCodexJournalString(item, 'command')
    if (command) {
      const boundedCommand = Buffer.from(command, 'utf8')
        .subarray(0, MAX_CODEX_DETAIL_BYTES)
        .toString('utf8')
      this.details.set(codexStructuredItemKey(event.threadId, item.id), boundedCommand)
    }
    const itemKey = codexStructuredItemKey(event.threadId, item.id)
    if (!translated.body) {
      if (event.method === 'item/completed') {
        this.streams.forget(event.threadId, item.id)
        this.activeItems.delete(itemKey)
      } else {
        this.track(event.threadId, turnId, item, identity)
        const admission = this.trimActiveState()
        if (!admission.accepted) {
          return { handled: true, admission }
        }
      }
      return { handled: true, admission: CODEX_JOURNAL_ADMITTED }
    }
    const admission = this.appendTranslated(event.method, identity, translated)
    if (!admission.accepted) {
      return { handled: true, admission }
    }
    if (event.method === 'item/completed') {
      this.streams.forget(event.threadId, item.id)
      this.activeItems.delete(itemKey)
    } else {
      this.track(event.threadId, turnId, item, identity)
      const trimAdmission = this.trimActiveState()
      if (!trimAdmission.accepted) {
        return { handled: true, admission: trimAdmission }
      }
    }
    return { handled: true, admission: CODEX_JOURNAL_ADMITTED }
  }

  dispose(): void {
    this.streams.dispose()
    this.identities.clear()
    this.details.clear()
    this.activeItems.clear()
  }

  private appendTranslated(
    method: string,
    identity: AgentJournalItemIdentity,
    translated: ReturnType<typeof codexJournalItem>
  ): CodexJournalTranslationAdmission {
    if (!translated.body) {
      return CODEX_JOURNAL_ADMITTED
    }
    if (method === 'item/completed') {
      const admission = appendCodexLifecycleItem(
        this.deps.sink,
        identity,
        translated.body,
        translated.blobs
      )
      return admission.accepted ? publishCodexLifecycle(this.deps.sink) : admission
    }
    const options = requiresTerminalSettlement(translated.body) ? { lifecycle: true } : {}
    const admission = this.deps.sink.tryAppendItem
      ? this.deps.sink.tryAppendItem(identity, translated.body, translated.blobs, options)
      : (this.deps.sink.appendItem(identity, translated.body, translated.blobs),
        CODEX_JOURNAL_ADMITTED)
    if (!admission.accepted) {
      return admission
    }
    return this.deps.sink.tryPublish
      ? this.deps.sink.tryPublish(options)
      : (this.deps.sink.publish(options), CODEX_JOURNAL_ADMITTED)
  }

  private track(
    threadId: string,
    turnId: string | null,
    item: CodexThreadItem,
    identity: AgentJournalItemIdentity
  ): void {
    this.streams.track(threadId, item, identity)
    this.activeItems.set(codexStructuredItemKey(threadId, item.id), {
      threadId,
      turnId,
      identity,
      item
    })
  }

  private identityFor(
    threadId: string,
    turnId: string | null,
    item: Parameters<typeof codexItemIdentity>[0]['item']
  ): AgentJournalItemIdentity {
    const key = codexStructuredItemKey(threadId, item.id)
    const existing = this.identities.get(key)
    if (existing) {
      return existing
    }
    const identity = codexItemIdentity({ threadId, turnId, item, ordinals: this.ordinals })
    this.identities.set(key, identity)
    while (this.identities.size > MAX_CODEX_IDENTITY_ENTRIES) {
      const oldest = this.identities.keys().next().value
      if (typeof oldest === 'string') {
        this.identities.delete(oldest)
      }
    }
    while (this.details.size > MAX_CODEX_DETAIL_ENTRIES) {
      const oldest = this.details.keys().next().value
      if (typeof oldest === 'string') {
        this.details.delete(oldest)
      }
    }
    return identity
  }

  private trimActiveState(): CodexJournalTranslationAdmission {
    while (this.activeItems.size > MAX_CODEX_ACTIVE_ITEMS) {
      const oldest = this.activeItems.keys().next().value
      if (typeof oldest !== 'string') {
        break
      }
      const evicted = this.activeItems.get(oldest)
      if (evicted) {
        const translated = codexJournalItem(evicted.item).body
        if (translated) {
          const admission = appendCodexLifecycleItem(
            this.deps.sink,
            evicted.identity,
            evictedActiveBody(translated)
          )
          if (!admission.accepted) {
            return admission
          }
          const published = publishCodexLifecycle(this.deps.sink)
          if (!published.accepted) {
            return published
          }
        }
        this.streams.forget(evicted.threadId, evicted.item.id)
        this.suppress(evicted.threadId, evicted.turnId ?? 'outside-turn')
      }
      this.activeItems.delete(oldest)
    }
    return CODEX_JOURNAL_ADMITTED
  }
}

function evictedActiveBody(body: AgentJournalItemBody): AgentJournalItemBody {
  if (body.kind === 'tool-call' && body.state === 'running') {
    return { ...body, state: 'failed' }
  }
  if (
    (body.kind === 'approval' || body.kind === 'question') &&
    body.resolution.state === 'pending'
  ) {
    return {
      ...body,
      resolution: {
        state: 'cancelled',
        selectedOptionId: null,
        resolvedBy: null,
        resolvedAt: null
      }
    }
  }
  return body
}
