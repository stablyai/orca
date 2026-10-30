// Publish before task_started using the spawn ID; correct attribution later without replacing content.

import { agentJournalLinkageFields } from '../../shared/agent-session-journal-producer'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity,
  AgentJournalProducerLinkage,
  AgentJournalTurnScope
} from '../../shared/agent-session-journal-types'
import type { StructuredAgentSessionItemAppendOptions } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import type { ClaudeSubagentLinkageSource } from './claude-subagent-linkage'

export type ClaudeRowStamp = (
  identity: AgentJournalItemIdentity,
  body: AgentJournalItemBody
) => StructuredAgentSessionItemAppendOptions

const MAX_OUTSTANDING_CORRECTIONS = 256

/** Limit each producer so one child cannot evict all others' corrections. */
const MAX_CORRECTIONS_PER_REF = 128

type OutstandingCorrection = {
  ref: string
  identity: AgentJournalItemIdentity
  /** Keep the newest body so restamping cannot revert a tool call to its pre-result state. */
  body: AgentJournalItemBody
  stamped: StructuredAgentSessionItemAppendOptions
}

export type ClaudeProvisionalRowCorrectionsDeps = ClaudeSubagentLinkageSource & {
  turnScope: () => AgentJournalTurnScope
  /** Revise in place; false means backpressure refused the correction and it still needs retrying. */
  rewrite: (
    identity: AgentJournalItemIdentity,
    body: AgentJournalItemBody,
    options: StructuredAgentSessionItemAppendOptions
  ) => boolean
  publish: () => void
}

export class ClaudeProvisionalRowCorrections {
  private readonly outstanding = new Map<string, OutstandingCorrection>()
  /** Stop queueing corrections for evicted producers so unresolved rows keep consistent IDs. */
  private readonly givenUp = new Set<string>()

  constructor(private readonly deps: ClaudeProvisionalRowCorrectionsDeps) {}

  get pending(): number {
    return this.outstanding.size
  }

  stampFor(parentToolUseId: string | null): ClaudeRowStamp {
    if (parentToolUseId === null) {
      return (identity) => {
        this.supersede(identity)
        return { turnScope: this.deps.turnScope() }
      }
    }
    return (identity, body) => {
      const provisional = this.deps.linkageFor(parentToolUseId).kind === 'pending'
      const options = { ...this.stamp(parentToolUseId), turnScope: this.deps.turnScope() }
      if (provisional) {
        this.remember(parentToolUseId, identity, body, options)
      } else {
        this.supersede(identity)
      }
      return options
    }
  }

  retry(): void {
    let wrote = false
    for (const [itemId, correction] of this.outstanding) {
      if (this.deps.linkageFor(correction.ref).kind === 'pending') {
        continue
      }
      const outcome = this.settle(correction)
      // Retain refused corrections for another retry or the final abandon attempt.
      if (outcome !== 'refused') {
        this.outstanding.delete(itemId)
      }
      wrote = outcome === 'wrote' || wrote
    }
    if (wrote) {
      this.deps.publish()
    }
  }

  /** Make a final correction attempt; unresolved identities keep their provisional stamps. */
  abandon(): void {
    let wrote = false
    for (const correction of this.outstanding.values()) {
      wrote = this.settle(correction) === 'wrote' || wrote
    }
    this.outstanding.clear()
    this.givenUp.clear()
    if (wrote) {
      this.deps.publish()
    }
  }

  /** A final write supersedes pending corrections, even when it uses another producer reference. */
  private supersede(identity: AgentJournalItemIdentity): void {
    this.outstanding.delete(agentJournalItemKey(identity))
  }

  private stamp(parentToolUseId: string): ReturnType<typeof agentJournalLinkageFields> {
    return agentJournalLinkageFields(this.deps.settledLinkageFor(parentToolUseId).linkage)
  }

  private settle(correction: OutstandingCorrection): 'wrote' | 'unchanged' | 'refused' {
    const options = this.stamp(correction.ref)
    if (sameLinkage(options, correction.stamped)) {
      return 'unchanged'
    }
    // Preserve the original turn scope when revising attribution.
    const restamped = { ...options, turnScope: correction.stamped.turnScope }
    return this.deps.rewrite(correction.identity, correction.body, restamped) ? 'wrote' : 'refused'
  }

  private remember(
    ref: string,
    identity: AgentJournalItemIdentity,
    body: AgentJournalItemBody,
    stamped: StructuredAgentSessionItemAppendOptions
  ): void {
    if (this.givenUp.has(ref)) {
      return
    }
    const itemId = agentJournalItemKey(identity)
    // Reinsert so eviction order follows the newest write, not the first one.
    this.outstanding.delete(itemId)
    this.outstanding.set(itemId, { ref, identity, body, stamped })
    if (this.countFor(ref) > MAX_CORRECTIONS_PER_REF) {
      this.giveUp(ref)
    }
    while (this.outstanding.size > MAX_OUTSTANDING_CORRECTIONS) {
      this.giveUpOnOldest()
    }
  }

  /** Abandon all pending rows for a producer to avoid splitting its attribution across IDs. */
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
  left: AgentJournalProducerLinkage,
  right: AgentJournalProducerLinkage
): boolean {
  return (
    left.agentId === right.agentId &&
    left.parentAgentId === right.parentAgentId &&
    left.providerParentRef === right.providerParentRef &&
    left.producerKind === right.producerKind &&
    left.attempt === right.attempt
  )
}
