import type { AgentJournalRowAttribution } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { appendCodexItemAndPublish } from '../journal/codex-structured-journal-sink'
import {
  pendingPatchBytes,
  codexOutputGrowthCheckpointDue
} from './codex-structured-item-stream-bounds'
import {
  agentSessionTextCheckpointDueIn,
  type AgentSessionDeltaCoalescer,
  type AgentSessionDeltaSnapshot
} from '../../../native-chat/agent-session-wire/publication/subscribers/agent-session-delta-coalescer'
import type {
  CodexItemStreamDeps,
  CodexStructuredItemStreamAdmission,
  CodexPendingItemPatch
} from './codex-structured-item-stream-contracts'

/** Saves retained patch snapshots and decides when running command or file output saves. */
export class CodexItemStreamCheckpoints {
  constructor(
    private readonly deps: Pick<CodexItemStreamDeps, 'sink'> & {
      pendingPatches: Map<string, CodexPendingItemPatch>
      attributionOf: (key: string) => AgentJournalRowAttribution
      releasePatch: (bytes: number) => void
      typeFor: (key: string) => string | undefined
      acceptedAt: ReadonlyMap<string, number>
      checkpointLengths: ReadonlyMap<string, number>
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

  /** Text waits for its save interval; the coalescer re-arms for it. */
  dueIn(key: string): number {
    return codexTimeGatedText(this.deps.typeFor(key))
      ? agentSessionTextCheckpointDueIn(this.deps.acceptedAt.get(key))
      : 0
  }

  shouldPersist(key: string, textLength: number): boolean {
    // Command and file output keep growth checkpoints to limit repeated full previews.
    return (
      codexTimeGatedText(this.deps.typeFor(key)) ||
      codexOutputGrowthCheckpointDue(this.deps.checkpointLengths.get(key) ?? 0, textLength)
    )
  }
}

function codexTimeGatedText(type: string | undefined): boolean {
  return type === 'agentMessage' || type === 'reasoning' || type === 'plan'
}

export function flushCodexItemStreamCheckpoints(
  deps: {
    coalescer: AgentSessionDeltaCoalescer
    pendingCheckpoints: Set<string>
    producers: ReadonlyMap<string, { threadId: string }>
    checkpointLengths: ReadonlyMap<string, number>
    persist: (
      key: string,
      snapshot: AgentSessionDeltaSnapshot
    ) => CodexStructuredItemStreamAdmission
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
  let flushed = coalescer.flushAll(
    threadId === undefined ? undefined : (key) => producers.get(key)?.threadId === threadId
  )
  if (!flushed.accepted && flushed.reason !== 'backpressure') {
    return flushed
  }
  for (const key of pendingCheckpoints) {
    // flushAll already placed every stream's first row; re-saving other threads would bypass their cadence.
    if (threadId !== undefined && producers.get(key)?.threadId !== threadId) {
      continue
    }
    const snapshot = coalescer.snapshot(key)
    if (snapshot && checkpointLengths.get(key) !== snapshot.textLength) {
      const admission = persist(key, snapshot)
      if (!admission.accepted) {
        flushed = admission
        if (admission.reason !== 'backpressure') {
          return admission
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
