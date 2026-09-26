// Rows written before their producer had a final identity, and the correction
// owed to each.
//
// A subagent's first frames can arrive before the `task_started` that names it.
// The row is written anyway, stamped with the only handle that exists yet — the
// spawn call's own id. It is not held: bookkeeping must never gate a user's
// view of what an agent said, and a row withheld for an announcement that never
// comes is output the user never sees.
//
// The stamp is then corrected in place. Re-appending the same `itemId` bumps
// its revision and the reducer rebuilds the row's linkage from the newest one,
// pinning `sequence` and `observedAt` so the correction refreshes attribution
// without moving the bubble. That is the same mechanism the streamed-text
// checkpoints and the subagent group row already use.
//
// What this must never do is make a row WORSE. Every exit either writes a
// strictly better stamp or drops the correction untouched; losing one costs a
// row the canonical id, never its content and never its author.

import { agentJournalLinkageFields } from '../../shared/agent-session-journal-producer'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity
} from '../../shared/agent-session-journal-types'
import type { StructuredAgentSessionAppendOptions } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import type { ClaudeSubagentLinkageSource } from './claude-subagent-linkage'

/**
 * Stamps one row with its producer, and remembers it when that producer's
 * identity is still provisional.
 *
 * The row is always written by the caller, immediately, with whatever this
 * returns. No site chooses — the envelope it came from already decided.
 */
export type ClaudeRowStamp = (
  identity: AgentJournalItemIdentity,
  body: AgentJournalItemBody
) => StructuredAgentSessionAppendOptions

/** The session's own agent wrote this row: nothing is stamped, nothing is owed.
 *  Only for a site with no ledger to consult; a ledger-backed root write goes
 *  through `stampFor(null)`, which also supersedes anything owed to the row. */
export const rootClaudeRowStamp: ClaudeRowStamp = () => ({})

/** Corrections outstanding at once, across every producer. */
const MAX_OUTSTANDING_CORRECTIONS = 256

/** Per producer, so one child talking hard before its announcement cannot push
 *  out every other child's corrections along with its own. */
const MAX_CORRECTIONS_PER_REF = 128

type OutstandingCorrection = {
  ref: string
  identity: AgentJournalItemIdentity
  /** The newest body written under this identity. Two writes can share one —
   *  a tool call and its result do — and a correction carrying the older body
   *  would revert the row it is only meant to re-attribute. */
  body: AgentJournalItemBody
  stamped: StructuredAgentSessionAppendOptions
}

export type ClaudeProvisionalRowCorrectionsDeps = ClaudeSubagentLinkageSource & {
  /** Re-appends a row under its own identity, which revises it in place.
   *  Returns whether the write was ADMITTED: a sink under backpressure refuses,
   *  and a correction dropped on a refusal is an obligation nothing re-derives. */
  rewrite: (
    identity: AgentJournalItemIdentity,
    body: AgentJournalItemBody,
    options: StructuredAgentSessionAppendOptions
  ) => boolean
  publish: () => void
}

export class ClaudeProvisionalRowCorrections {
  /** Keyed by `itemId`, so a second write to one row replaces the correction
   *  owed to it rather than queueing a stale body behind the fresh one. */
  private readonly outstanding = new Map<string, OutstandingCorrection>()
  /** Producers whose correction was abandoned at the bound. Remembered so later
   *  rows are not queued for a correction their siblings will never get. */
  private readonly givenUp = new Set<string>()

  constructor(private readonly deps: ClaudeProvisionalRowCorrectionsDeps) {}

  get pending(): number {
    return this.outstanding.size
  }

  /** How rows from one envelope are attributed. A null reference is the
   *  session's own agent; anything else is a child of it. */
  stampFor(parentToolUseId: string | null): ClaudeRowStamp {
    if (parentToolUseId === null) {
      return (identity) => {
        this.supersede(identity)
        return {}
      }
    }
    return (identity, body) => {
      const provisional = this.deps.linkageFor(parentToolUseId).kind === 'pending'
      const options = this.stamp(parentToolUseId)
      if (provisional) {
        this.remember(parentToolUseId, identity, body, options)
      } else {
        this.supersede(identity)
      }
      return options
    }
  }

  /** An announcement may have named a producer rows are already stamped with.
   *  Rewrites those whose stamp would now differ and forgets the rest. */
  retry(): void {
    let wrote = false
    // Map iteration tolerates deletion of the entry just visited.
    for (const [itemId, correction] of this.outstanding) {
      if (this.deps.linkageFor(correction.ref).kind === 'pending') {
        continue
      }
      const outcome = this.settle(correction)
      // Kept outstanding when the sink refused it, so `abandon` gets another
      // go. Dropping it here would strand the row on a stamp nothing revisits.
      if (outcome !== 'refused') {
        this.outstanding.delete(itemId)
      }
      wrote = outcome === 'wrote' || wrote
    }
    if (wrote) {
      this.deps.publish()
    }
  }

  /** Nothing further can name these producers, so no correction is coming. The
   *  rows keep the stamp they already carry; at settle it is the same verdict,
   *  so this writes nothing and burns no revision. */
  abandon(): void {
    let wrote = false
    for (const correction of this.outstanding.values()) {
      // Last attempt. A refusal here ends it: the row keeps a usable id, and an
      // obligation with no exit is worse than one that settles for less.
      wrote = this.settle(correction) === 'wrote' || wrote
    }
    this.outstanding.clear()
    this.givenUp.clear()
    if (wrote) {
      this.deps.publish()
    }
  }

  /**
   * A settled write lands on a row a correction was owed to, so the correction
   * goes.
   *
   * Dropped rather than re-bodied: a settled write already carries a FINAL
   * verdict, so the correction could only restamp the row from a reference this
   * write did not use — equal at best, and at worst the older body. One row can
   * legitimately be written under two references (a call and its result), and
   * this is what keeps a correction owed to the first from outliving the second.
   */
  private supersede(identity: AgentJournalItemIdentity): void {
    this.outstanding.delete(agentJournalItemKey(identity))
  }

  private stamp(parentToolUseId: string): StructuredAgentSessionAppendOptions {
    return agentJournalLinkageFields(this.deps.settledLinkageFor(parentToolUseId).linkage)
  }

  /** Writes the correction only when it actually changes the row's attribution.
   *  A duplicate must not burn a revision. */
  private settle(correction: OutstandingCorrection): 'wrote' | 'unchanged' | 'refused' {
    const options = this.stamp(correction.ref)
    if (sameLinkage(options, correction.stamped)) {
      return 'unchanged'
    }
    return this.deps.rewrite(correction.identity, correction.body, options) ? 'wrote' : 'refused'
  }

  private remember(
    ref: string,
    identity: AgentJournalItemIdentity,
    body: AgentJournalItemBody,
    stamped: StructuredAgentSessionAppendOptions
  ): void {
    if (this.givenUp.has(ref)) {
      return
    }
    const itemId = agentJournalItemKey(identity)
    // Re-inserted rather than updated in place, so the newest write is also the
    // youngest — insertion order is what `giveUpOnOldest` reads.
    this.outstanding.delete(itemId)
    this.outstanding.set(itemId, { ref, identity, body, stamped })
    if (this.countFor(ref) > MAX_CORRECTIONS_PER_REF) {
      this.giveUp(ref)
    }
    while (this.outstanding.size > MAX_OUTSTANDING_CORRECTIONS) {
      this.giveUpOnOldest()
    }
  }

  /**
   * Stops correcting one producer, and forgets what was owed it.
   *
   * WHOLESALE, never row by row. Correcting some of a child's rows and not the
   * rest splits one child across two ids in the same session — worse than
   * correcting none, because the rows left behind are the ones a reader would
   * have to reconcile. Giving up leaves every one of them on the spawn call's
   * id: still that child's, still not the parent's, and still all the same.
   */
  private giveUp(ref: string): void {
    this.givenUp.add(ref)
    for (const [itemId, entry] of this.outstanding) {
      if (entry.ref === ref) {
        this.outstanding.delete(itemId)
      }
    }
  }

  private giveUpOnOldest(): void {
    for (const entry of this.outstanding.values()) {
      this.giveUp(entry.ref)
      return
    }
  }

  private countFor(ref: string): number {
    let count = 0
    for (const entry of this.outstanding.values()) {
      if (entry.ref === ref) {
        count += 1
      }
    }
    return count
  }
}

function sameLinkage(
  left: StructuredAgentSessionAppendOptions,
  right: StructuredAgentSessionAppendOptions
): boolean {
  return (
    left.agentId === right.agentId &&
    left.parentAgentId === right.parentAgentId &&
    left.providerParentRef === right.providerParentRef &&
    left.producerKind === right.producerKind &&
    left.attempt === right.attempt
  )
}
