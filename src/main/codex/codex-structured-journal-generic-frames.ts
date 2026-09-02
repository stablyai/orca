import { unhandledProviderFrameJournalItem } from '../native-chat/agent-session-wire/unhandled-provider-frame'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import type {
  CodexJournalTranslationAdmission,
  CodexJournalTranslatorDeps
} from './codex-structured-journal-contracts'
import { CODEX_JOURNAL_ADMITTED } from './codex-structured-journal-contracts'
import {
  MAX_CODEX_GENERIC_BOOKKEEPING_BYTES,
  MAX_CODEX_GENERIC_BOOKKEEPING_ENTRIES,
  MAX_CODEX_GENERIC_ROWS_PER_TURN,
  MAX_CODEX_GENERIC_TURN_BUCKETS
} from './codex-structured-journal-limits'
import { readCodexTurnId } from './codex-structured-thread-facts'

const OVERFLOW_BUCKET = '__codex-generic-overflow__'
type SuppressedSummary = { count: number; publishedCount: number }

function boundedTurnBucket(threadId: string, turnId: string): string {
  const encoded = `${encodeURIComponent(threadId)}:${encodeURIComponent(turnId)}`
  if (Buffer.byteLength(encoded, 'utf8') <= 512) {
    return encoded
  }
  let hash = 2166136261
  for (const byte of Buffer.from(encoded, 'utf8')) {
    hash ^= byte
    hash = Math.imul(hash, 16777619)
  }
  return `${encoded.slice(0, 160)}:${(hash >>> 0).toString(16)}`
}

function defaultSchedule(run: () => void, ms: number): () => void {
  const timer = setTimeout(run, ms)
  timer.unref?.()
  return () => clearTimeout(timer)
}

function publish(sink: StructuredAgentSessionEventSink): CodexJournalTranslationAdmission {
  return sink.tryPublish ? sink.tryPublish() : (sink.publish(), CODEX_JOURNAL_ADMITTED)
}

export class CodexJournalGenericFrames {
  private readonly genericRowsByTurn = new Map<string, number>()
  private readonly suppressedRowsByTurn = new Map<string, SuppressedSummary>()
  private readonly bucketOrder = new Map<string, number>()
  private readonly schedule: NonNullable<CodexJournalTranslatorDeps['schedule']>
  private readonly suppressionCoalesceMs: number
  private nextBucketOrder = 0
  private bookkeepingBytes = 0
  private fallbackSequence = 0
  private cancelSuppressionFlush: (() => void) | null = null

  constructor(
    private readonly deps: Pick<CodexJournalTranslatorDeps, 'sink' | 'schedule' | 'coalesceMs'>,
    private readonly activeTurn: (threadId: string) => string | null
  ) {
    this.schedule = deps.schedule ?? defaultSchedule
    this.suppressionCoalesceMs = deps.coalesceMs ?? 60
  }

  appendUnhandled(
    kind: string,
    payload: unknown,
    threadId = 'session'
  ): CodexJournalTranslationAdmission {
    const translated = unhandledProviderFrameJournalItem('codex', kind, payload)
    // A frame the classifier declines is deliberately not journaled, which is success.
    // Failing admission here force-closes the provider through the retry queue.
    if (!translated) {
      return CODEX_JOURNAL_ADMITTED
    }
    const turnId = readCodexTurnId(payload) ?? this.activeTurn(threadId) ?? 'outside-turn'
    const bucket = this.bucketFor(threadId, turnId)
    const rowCount = this.genericRowsByTurn.get(bucket) ?? 0
    // The cap bounds noise, never evidence: an error frame is always journaled, and
    // capped frames stay countable through one summary row per turn.
    const isError = translated.classification === 'error-surface'
    if (!isError && rowCount >= MAX_CODEX_GENERIC_ROWS_PER_TURN) {
      this.addSuppressed(bucket, 1)
      this.recordBucket(bucket)
      this.scheduleSuppressedRows()
      return CODEX_JOURNAL_ADMITTED
    }
    if (isError) {
      const suppressionAdmission = this.flush()
      if (!suppressionAdmission.accepted) {
        return suppressionAdmission
      }
    }
    this.fallbackSequence += 1
    const admission = this.deps.sink.tryAppendItem
      ? this.deps.sink.tryAppendItem(
          { provider: 'orca', clientMessageId: `provider-frame:codex:${this.fallbackSequence}` },
          translated.body,
          translated.blobs
        )
      : (this.deps.sink.appendItem(
          { provider: 'orca', clientMessageId: `provider-frame:codex:${this.fallbackSequence}` },
          translated.body,
          translated.blobs
        ),
        CODEX_JOURNAL_ADMITTED)
    if (!admission.accepted) {
      this.fallbackSequence -= 1
      return admission
    }
    this.genericRowsByTurn.set(bucket, rowCount + 1)
    this.recordBucket(bucket)
    return publish(this.deps.sink)
  }

  suppress(threadId: string, turnId: string, count = 1): void {
    const bucket = this.bucketFor(threadId, turnId)
    this.addSuppressed(bucket, count)
    this.recordBucket(bucket)
  }

  flush = (): CodexJournalTranslationAdmission => {
    this.cancelSuppressionFlush?.()
    this.cancelSuppressionFlush = null
    let wrote = false
    const ready: SuppressedSummary[] = []
    let blocked: CodexJournalTranslationAdmission | null = null
    for (const [bucket, summary] of this.suppressedRowsByTurn) {
      if (summary.count === summary.publishedCount) {
        continue
      }
      const text =
        bucket === OVERFLOW_BUCKET
          ? `${summary.count} more provider notification${summary.count === 1 ? '' : 's'} not shown across evicted turns`
          : `${summary.count} more provider notification${summary.count === 1 ? '' : 's'} not shown for this turn`
      const admission = this.deps.sink.tryAppendItem
        ? this.deps.sink.tryAppendItem(
            { provider: 'orca', clientMessageId: `provider-frame-suppressed:codex:${bucket}` },
            {
              kind: 'status',
              text
            },
            [],
            { coalescingKey: `provider-frame-suppressed:codex:${bucket}` }
          )
        : (this.deps.sink.appendItem(
            { provider: 'orca', clientMessageId: `provider-frame-suppressed:codex:${bucket}` },
            { kind: 'status', text },
            [],
            { coalescingKey: `provider-frame-suppressed:codex:${bucket}` }
          ),
          CODEX_JOURNAL_ADMITTED)
      if (!admission.accepted) {
        blocked ??= admission
        continue
      }
      ready.push(summary)
      wrote = true
    }
    if (wrote) {
      const admission = publish(this.deps.sink)
      if (!admission.accepted) {
        blocked ??= admission
      } else {
        for (const summary of ready) {
          summary.publishedCount = summary.count
        }
      }
    }
    if (blocked) {
      this.scheduleSuppressedRows()
      return blocked
    }
    return CODEX_JOURNAL_ADMITTED
  }

  dispose(): void {
    this.cancelSuppressionFlush?.()
    this.genericRowsByTurn.clear()
    this.suppressedRowsByTurn.clear()
    this.bucketOrder.clear()
    this.bookkeepingBytes = 0
  }

  private scheduleSuppressedRows(): void {
    this.cancelSuppressionFlush ??= this.schedule(() => {
      this.cancelSuppressionFlush = null
      this.flush()
    }, this.suppressionCoalesceMs)
  }

  private bucketFor(threadId: string, turnId: string): string {
    const requested = boundedTurnBucket(threadId, turnId)
    return Buffer.byteLength(requested, 'utf8') > MAX_CODEX_GENERIC_BOOKKEEPING_BYTES
      ? OVERFLOW_BUCKET
      : requested
  }

  private addSuppressed(bucket: string, count: number): void {
    const summary = this.suppressedRowsByTurn.get(bucket) ?? { count: 0, publishedCount: 0 }
    summary.count += count
    this.suppressedRowsByTurn.set(bucket, summary)
  }

  private recordBucket(bucket: string): void {
    if (!this.bucketOrder.has(bucket)) {
      this.bucketOrder.set(bucket, this.nextBucketOrder++)
      this.bookkeepingBytes += Buffer.byteLength(bucket, 'utf8')
    }
    while (
      (this.bucketOrder.size > MAX_CODEX_GENERIC_TURN_BUCKETS ||
        this.genericRowsByTurn.size + this.suppressedRowsByTurn.size >
          MAX_CODEX_GENERIC_BOOKKEEPING_ENTRIES ||
        this.bookkeepingBytes > MAX_CODEX_GENERIC_BOOKKEEPING_BYTES) &&
      this.bucketOrder.size > 1
    ) {
      const oldest = [...this.bucketOrder.entries()]
        .filter(([id]) => id !== OVERFLOW_BUCKET && id !== bucket)
        .sort((a, b) => a[1] - b[1])[0]?.[0]
      if (!oldest) {
        break
      }
      const suppressed = this.suppressedRowsByTurn.get(oldest)
      this.removeBucket(oldest)
      if (suppressed && suppressed.count > suppressed.publishedCount) {
        this.recordBucket(OVERFLOW_BUCKET)
        this.addSuppressed(OVERFLOW_BUCKET, suppressed.count - suppressed.publishedCount)
      }
    }
  }

  private removeBucket(bucket: string): void {
    this.genericRowsByTurn.delete(bucket)
    this.suppressedRowsByTurn.delete(bucket)
    this.bookkeepingBytes = Math.max(0, this.bookkeepingBytes - Buffer.byteLength(bucket, 'utf8'))
    this.bucketOrder.delete(bucket)
  }
}
