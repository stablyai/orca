import type { AgentSessionConversationView } from '../../../shared/agent-session-conversation-view'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'

export type StructuredAgentSessionWorkEvidence = {
  record: Pick<AgentSessionConversationView, 'ownerObservation' | 'currentFence'> | null
  ended?: StructuredAgentSessionSeenEnd
  revision?: number
  replaced?: StructuredAgentSessionReplacedEnd | undefined
  /** Absent means the host has no child observation. */
  child?: { fence: number; heldSends?: () => ReadonlySet<string> | undefined } | null
}

/** Replaced runtimes granted all fences through this boundary. */
export type StructuredAgentSessionReplacedEnd = { fence: number }

export type StructuredAgentSessionSeenEnd = {
  fence: number
  rootGone?: boolean
  cause?: string
}

/** Missing records retain legacy fence-0 behavior; released/ended generations have no live fence. */
export function structuredAgentSessionLiveFence(
  evidence: StructuredAgentSessionWorkEvidence
): number | null {
  const record = evidence.record
  const lease = record?.ownerObservation
  const fence = record?.currentFence
  if (!lease) {
    return 0
  }
  if (lease.claimStatus === 'released') {
    return null
  }
  if (
    structuredAgentSessionReplacedRuntimeEnded(
      { runtimeFence: fence ?? 0, claimStatus: lease.claimStatus },
      evidence.replaced
    ) ||
    structuredAgentSessionOwnerUnverifiable(evidence)
  ) {
    return null
  }
  const { ended } = evidence
  return ended?.rootGone === true && ended.fence === fence ? null : (fence ?? 0)
}

/** Unreconciled/recovering owners without a local child remain unverifiable, not current work. */
export function structuredAgentSessionOwnerUnverifiable(
  evidence: StructuredAgentSessionWorkEvidence
) {
  const record = evidence.record
  const lease = record?.ownerObservation
  const fence = record?.currentFence
  return (
    (lease?.unreconciled === true || lease?.handoffStage === 'recovering') &&
    evidence.child !== undefined &&
    evidence.child?.fence !== fence
  )
}

/** Replaced runtimes lost their pipes; conflicted terminal claims are outside that proof. */
export function structuredAgentSessionReplacedRuntimeEnded(
  lease: Pick<AgentSessionRecord['lease'], 'runtimeFence' | 'claimStatus'>,
  replaced: StructuredAgentSessionReplacedEnd | undefined
): boolean {
  return (
    replaced !== undefined &&
    lease.runtimeFence <= replaced.fence &&
    lease.claimStatus !== 'conflicted'
  )
}
