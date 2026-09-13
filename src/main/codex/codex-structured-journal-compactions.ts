import { createHash } from 'node:crypto'
import { isCodexCompactionComplete } from '../native-chat/agent-session-wire/structured-session-compaction'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import {
  CODEX_JOURNAL_ADMITTED,
  type CodexJournalTranslationAdmission
} from './codex-structured-journal-contracts'
import { MAX_CODEX_GENERIC_TURN_BUCKETS } from './codex-structured-journal-limits'
import { appendCodexLifecycleItem, publishCodexLifecycle } from './codex-structured-journal-sink'
import { readCodexTurnId } from './codex-structured-thread-facts'

export class CodexJournalCompactions {
  private readonly turns = new Map<string, 'item' | 'legacy'>()

  constructor(
    private readonly sink: StructuredAgentSessionEventSink,
    private readonly activeTurn: (threadId: string) => string | null
  ) {}

  handle(event: {
    threadId: string
    method: string
    params: unknown
  }): CodexJournalTranslationAdmission | null {
    if (!isCodexCompactionComplete(event.method, event.params)) {
      return null
    }
    const turnId = readCodexTurnId(event.params) ?? this.activeTurn(event.threadId)
    if (!turnId) {
      return null
    }
    // Collapse compactions within a thread/turn; the canonical item replaces its legacy fallback.
    const key = createHash('sha256')
      .update(JSON.stringify([event.threadId, turnId]))
      .digest('hex')
    const source = event.method === 'item/completed' ? 'item' : 'legacy'
    const previous = this.turns.get(key)
    if (previous === 'item' || previous === source) {
      return CODEX_JOURNAL_ADMITTED
    }
    const admission = appendCodexLifecycleItem(
      this.sink,
      { provider: 'orca', clientMessageId: `codex-compaction:${key}` },
      { kind: 'status', text: 'Context compacted', presentation: 'compaction' }
    )
    if (!admission.accepted) {
      return admission
    }
    const published = publishCodexLifecycle(this.sink)
    if (!published.accepted) {
      return published
    }
    this.turns.set(key, source)
    while (this.turns.size > MAX_CODEX_GENERIC_TURN_BUCKETS) {
      const oldest = this.turns.keys().next().value
      if (oldest !== undefined) {
        this.turns.delete(oldest)
      }
    }
    return CODEX_JOURNAL_ADMITTED
  }

  clear(): void {
    this.turns.clear()
  }
}
