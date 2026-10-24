import type {
  AgentJournalItemIdentity,
  AgentJournalRowAttribution
} from '../../shared/agent-session-journal-types'
import { codexLiveTextKey } from './codex-thread-item-identity'
import { requiresTerminalSettlement } from '../native-chat/agent-session-journal/journal-terminal-settlement'
import {
  codexItemIdentity,
  codexJournalItem,
  CodexTurnOrdinals,
  readCodexThreadItem,
  type CodexThreadItem
} from './codex-structured-item-translation'
import { createCodexStructuredItemStreams } from './codex-structured-item-streams'
import type { CodexHelperName } from './codex-collab-agent-item-translation'
import { boundStreamItem, codexStructuredItemKey } from './codex-structured-item-stream-bounds'
import { codexCommandOutlivesTurn } from './codex-command-lifecycle'
import type {
  CodexActiveJournalItem,
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
import { readCodexJournalString } from './codex-structured-journal-translation-values'
import { readCodexTurnId } from './codex-structured-thread-facts'
import { readCodexDispatchEcho } from './codex-structured-dispatch-echo'
import {
  codexCompletedItem,
  withCodexItemLifecycle,
  settleEvictedCodexItem
} from './codex-unfinished-item-body'
import {
  endedJournalReasoning,
  type JournalReasoningLifecycle
} from '../native-chat/agent-session-journal/journal-reasoning-row'
import type { CodexRowAttribution } from './codex-subagent-linkage'

export class CodexJournalItems {
  readonly ordinals = new CodexTurnOrdinals()
  readonly activeItems = new Map<string, CodexActiveJournalItem>()
  readonly streams
  private readonly identities = new Map<string, AgentJournalItemIdentity>()
  private readonly details = new Map<string, string>()

  constructor(
    private readonly deps: Pick<
      CodexJournalTranslatorDeps,
      'sink' | 'coalesceMs' | 'maxRetainedBytes' | 'schedule' | 'now' | 'historyImport'
    > & { attributionFor: CodexRowAttribution },
    private readonly activeTurn: (threadId: string) => string | null,
    private readonly suppress: (threadId: string, turnId: string) => void,
    private readonly helperName?: CodexHelperName
  ) {
    this.streams = createCodexStructuredItemStreams({
      sink: deps.sink,
      historyImport: deps.historyImport,
      coalesceMs: deps.coalesceMs,
      maxRetainedBytes: deps.maxRetainedBytes,
      schedule: deps.schedule,
      turnIdFor: (threadId, params) => readCodexTurnId(params) ?? this.activeTurn(threadId),
      identityFor: (threadId, turnId, item) => this.identityFor(threadId, turnId, item),
      attributionFor: deps.attributionFor
    })
  }

  detailFor(threadId: string, itemId: string): string | null {
    return this.details.get(codexStructuredItemKey(threadId, itemId)) ?? null
  }

  handle(
    event: { threadId: string; method: string; params: unknown; observedAt?: number },
    source: 'live' | 'history' = 'live'
  ): CodexItemTranslation {
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
    // Count echoes for stable resume ordinals, but user bubbles come from submissions.
    if (source === 'live' && item.type === 'userMessage') {
      const echo = readCodexDispatchEcho(item, identity)
      return {
        handled: true,
        admission: CODEX_JOURNAL_ADMITTED,
        ...(echo ? { dispatchEcho: echo } : {})
      }
    }
    if (item.type === 'contextCompaction' && event.method === 'item/started') {
      return { handled: true, admission: CODEX_JOURNAL_ADMITTED }
    }
    const itemKey = codexStructuredItemKey(event.threadId, item.id)
    const active = event.method === 'item/completed' ? this.activeItems.get(itemKey) : undefined
    const receivedAt = event.observedAt ?? this.deps.now?.() ?? Date.now()
    const lifecycle: JournalReasoningLifecycle =
      source === 'history'
        ? endedJournalReasoning()
        : event.method === 'item/completed'
          ? // Without a recorded start, completion cannot establish a duration.
            endedJournalReasoning(active?.startedAt === undefined ? undefined : receivedAt)
          : { state: 'running' }
    if (
      event.method === 'item/completed' &&
      item.type === 'reasoning' &&
      !codexJournalItem(item).body &&
      this.deps.sink.prepareText
    ) {
      const admission = this.streams.finish(event.threadId, turnId, receivedAt, item)
      if (admission.accepted) {
        this.streams.forget(event.threadId, item.id)
        this.activeItems.delete(itemKey)
      }
      return { handled: true, admission }
    }
    const translated = withCodexItemLifecycle(
      codexCompletedItem(
        codexJournalItem(item, this.helperName, active?.item),
        active,
        this.streams
      ),
      lifecycle
    )
    const command = readCodexJournalString(item, 'command')
    if (command) {
      const boundedCommand = Buffer.from(command, 'utf8')
        .subarray(0, MAX_CODEX_DETAIL_BYTES)
        .toString('utf8')
      this.details.set(itemKey, boundedCommand)
    }
    if (!translated.body) {
      if (event.method === 'item/completed') {
        this.streams.forget(event.threadId, item.id)
        this.activeItems.delete(itemKey)
      } else {
        const admission = this.trimActiveState(this.growsActiveSet(itemKey, item))
        if (!admission.accepted) {
          return { handled: true, admission }
        }
        // Preserve the start time while the row waits for its first text.
        this.track(event.threadId, turnId, item, identity, receivedAt)
      }
      return { handled: true, admission: CODEX_JOURNAL_ADMITTED }
    }
    // Coalescing can delay the first write until completion; preserve the item's start time.
    const startedAt = event.method === 'item/completed' ? active?.startedAt : receivedAt
    const admission = this.appendTranslated(event.method, identity, translated, {
      ...this.deps.attributionFor(event.threadId, turnId),
      ...(startedAt === undefined ? {} : { observedAt: startedAt })
    })
    if (!admission.accepted) {
      return { handled: true, admission }
    }
    if (event.method === 'item/completed') {
      this.streams.forget(event.threadId, item.id)
      this.activeItems.delete(itemKey)
    } else {
      const trimAdmission = this.trimActiveState(this.growsActiveSet(itemKey, item))
      if (!trimAdmission.accepted) {
        return { handled: true, admission: trimAdmission }
      }
      this.track(event.threadId, turnId, item, identity, receivedAt)
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
    translated: ReturnType<typeof codexJournalItem>,
    attribution: AgentJournalRowAttribution & { observedAt?: number }
  ): CodexJournalTranslationAdmission {
    if (!translated.body) {
      return CODEX_JOURNAL_ADMITTED
    }
    if (method === 'item/completed') {
      const admission = appendCodexLifecycleItem(
        this.deps.sink,
        identity,
        translated.body,
        attribution
      )
      return admission.accepted ? publishCodexLifecycle(this.deps.sink) : admission
    }
    const options = requiresTerminalSettlement(translated.body) ? { lifecycle: true } : {}
    const appendOptions = { ...options, ...attribution }
    const admission = this.deps.sink.tryAppendItem
      ? this.deps.sink.tryAppendItem(identity, translated.body, appendOptions)
      : (this.deps.sink.appendItem(identity, translated.body, appendOptions),
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
    identity: AgentJournalItemIdentity,
    startedAt?: number
  ): void {
    const retainedItem = codexCommandOutlivesTurn(item)
      ? (boundStreamItem(item) as CodexThreadItem)
      : item
    this.streams.track(threadId, turnId, retainedItem, identity, startedAt)
    this.activeItems.set(codexStructuredItemKey(threadId, item.id), {
      threadId,
      turnId,
      identity,
      item: retainedItem,
      ...(startedAt === undefined ? {} : { startedAt }),
      ...(this.helperName ? { helperName: this.helperName } : {})
    })
  }

  private identityFor(
    threadId: string,
    turnId: string | null,
    item: Parameters<typeof codexItemIdentity>[0]['item']
  ): AgentJournalItemIdentity {
    const key = this.deps.historyImport
      ? JSON.stringify([threadId, turnId, item.id])
      : codexStructuredItemKey(threadId, item.id)
    const live = this.deps.sink.liveText?.(
      codexLiveTextKey(threadId, turnId, item, this.deps.historyImport)
    )
    const existing = live?.live?.identity ?? this.identities.get(key)
    if (existing) {
      return existing
    }
    const identity = codexItemIdentity({
      threadId,
      turnId,
      item,
      ordinals: this.ordinals,
      historyImport: this.deps.historyImport
    })
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

  private growsActiveSet(itemKey: string, item: CodexThreadItem): boolean {
    return !this.activeItems.has(itemKey) && !codexCommandOutlivesTurn(item)
  }

  /** Evict before tracking so stream bounds cannot discard text needed to settle the evictee. */
  private trimActiveState(incoming: boolean): CodexJournalTranslationAdmission {
    const room = MAX_CODEX_ACTIVE_ITEMS - (incoming ? 1 : 0)
    while (this.activeItems.size - this.streams.persistentCount > room) {
      const oldest = [...this.activeItems].find(
        ([, active]) => !codexCommandOutlivesTurn(active.item)
      )?.[0]
      if (typeof oldest !== 'string') {
        break
      }
      const evicted = this.activeItems.get(oldest)
      if (evicted) {
        const admission = settleEvictedCodexItem(this.deps, evicted, this.streams)
        if (!admission.accepted) {
          return admission
        }
        this.streams.forget(evicted.threadId, evicted.item.id)
        if (!this.deps.sink.textSource?.(evicted.identity)) {
          this.suppress(evicted.threadId, evicted.turnId ?? 'outside-turn')
        }
      }
      this.activeItems.delete(oldest)
    }
    return CODEX_JOURNAL_ADMITTED
  }
}
