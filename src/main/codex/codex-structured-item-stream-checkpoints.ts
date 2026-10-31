import type { AgentJournalRowAttribution } from '../../shared/agent-session-journal-types'
import { appendCodexItemAndPublish } from './codex-structured-journal-sink'
import {
  pendingPatchBytes,
  codexOutputGrowthCheckpointDue
} from './codex-structured-item-stream-bounds'
import {
  AGENT_SESSION_DELTA_COALESCE_MS,
  AGENT_SESSION_TEXT_CHECKPOINT_MS,
  type AgentSessionDeltaCoalescer,
  scheduleAgentSessionDeltaFlush
} from '../native-chat/agent-session-wire/agent-session-delta-coalescer'
import type {
  CodexItemStreamDeps,
  CodexStructuredItemStreamAdmission,
  CodexPendingItemPatch
} from './codex-structured-item-stream-contracts'

/** References the producer's existing delivery state; owns only its plan wake handle and target. */
export class CodexItemStreamCheckpoints {
  private cancelTimer: (() => void) | undefined
  private target: number | undefined

  constructor(
    private readonly deps: Pick<
      CodexItemStreamDeps,
      'sink' | 'schedule' | 'isCurrent' | 'onScheduledFailure'
    > & {
      pendingPatches: Map<string, CodexPendingItemPatch>
      attributionOf: (key: string) => AgentJournalRowAttribution
      releasePatch: (bytes: number) => void
      windowMs?: number
      pending: ReadonlySet<string>
      typeFor: (key: string) => string | undefined
      acceptedAt: ReadonlyMap<string, number>
      checkpointLengths: ReadonlyMap<string, number>
      persist: (key: string) => CodexStructuredItemStreamAdmission
    }
  ) {}

  flushPatch(key: string): CodexStructuredItemStreamAdmission {
    const pending = this.deps.pendingPatches.get(key)
    if (!pending) {
      return { accepted: true }
    }
    const admission = appendCodexItemAndPublish(
      this.deps.sink,
      pending.identity,
      pending.body,
      this.deps.attributionOf(key)
    )
    if (!admission.accepted) {
      return admission
    }
    this.deps.releasePatch(pendingPatchBytes(pending))
    this.deps.pendingPatches.delete(key)
    return { accepted: true }
  }

  shouldPersist(key: string, textLength: number): boolean {
    const type = this.deps.typeFor(key)
    if (type === 'agentMessage' || type === 'reasoning' || type === 'plan') {
      const previous = this.deps.acceptedAt.get(key)
      const due = previous === undefined ? undefined : previous + AGENT_SESSION_TEXT_CHECKPOINT_MS
      if (due !== undefined && performance.now() < due) {
        // Plans need updates during pauses; assistant text and reasoning keep arrival-driven checkpoints.
        if (type === 'plan' && this.deps.pending.has(key)) {
          this.arm(due)
        }
        return false
      }
      return true
    }
    // Command and file output keep growth checkpoints to limit repeated full previews.
    return codexOutputGrowthCheckpointDue(this.deps.checkpointLengths.get(key) ?? 0, textLength)
  }

  cancel(): void {
    this.cancelTimer?.()
    this.cancelTimer = undefined
    this.target = undefined
  }

  fail(admission: CodexStructuredItemStreamAdmission & { accepted: false }): void {
    this.cancel()
    this.deps.onScheduledFailure?.(admission)
  }

  arm(target: number): void {
    if (this.target !== undefined && this.target <= target) {
      return
    }
    this.cancel()
    this.target = target
    this.cancelTimer = (this.deps.schedule ?? scheduleAgentSessionDeltaFlush)(
      () => {
        this.cancelTimer = undefined
        this.target = undefined
        if (this.deps.isCurrent?.() === false) {
          return
        }
        for (const key of this.deps.pending) {
          if (
            this.deps.typeFor(key) !== 'plan' ||
            !this.deps.acceptedAt.has(key) ||
            !this.shouldPersist(key, 0)
          ) {
            continue
          }
          const admission = this.deps.persist(key)
          if (!admission.accepted) {
            if (admission.reason !== 'backpressure') {
              this.fail(admission)
              return
            }
            this.arm(performance.now() + (this.deps.windowMs ?? AGENT_SESSION_DELTA_COALESCE_MS))
          }
        }
      },
      Math.max(0, target - performance.now())
    )
  }
}

export function flushCodexItemStreamCheckpoints(
  deps: {
    coalescer: AgentSessionDeltaCoalescer
    pendingCheckpoints: Set<string>
    producers: ReadonlyMap<string, { threadId: string }>
    checkpointLengths: ReadonlyMap<string, number>
    persist: (key: string, text: string) => CodexStructuredItemStreamAdmission
    typeFor: (key: string) => string | undefined
    pendingPatches: ReadonlyMap<string, unknown>
    flushPatch: (key: string) => CodexStructuredItemStreamAdmission
  },
  threadId?: string
): CodexStructuredItemStreamAdmission {
  const {
    coalescer,
    pendingCheckpoints,
    producers,
    checkpointLengths,
    persist,
    pendingPatches,
    flushPatch
  } = deps
  let flushed = coalescer.flushAll()
  if (!flushed.accepted && flushed.reason !== 'backpressure') {
    return flushed
  }
  for (const key of pendingCheckpoints) {
    // flushAll already placed every stream's first row; re-saving other threads would bypass their cadence.
    if (threadId !== undefined && producers.get(key)?.threadId !== threadId) {
      continue
    }
    const snapshot = coalescer.snapshot(key)
    if (snapshot && checkpointLengths.get(key) !== snapshot.text.length) {
      const admission = persist(key, snapshot.text)
      if (!admission.accepted) {
        if (deps.typeFor(key) === 'plan') {
          flushed = admission
          if (admission.reason !== 'backpressure') {
            return admission
          }
        } else {
          flushed = { accepted: false, reason: 'backpressure' }
        }
      }
    } else {
      pendingCheckpoints.delete(key)
    }
  }
  for (const key of pendingPatches.keys()) {
    if (!flushPatch(key).accepted) {
      flushed = { accepted: false, reason: 'backpressure' }
    }
  }
  return flushed
}
