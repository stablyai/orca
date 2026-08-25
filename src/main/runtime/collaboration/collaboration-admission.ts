import type { MessagePriority } from '../orchestration/types'

export type CollaborationMessage = {
  type: string
  priority: MessagePriority
}

export type CollaborationCandidate = {
  id: string
  message: CollaborationMessage
}

export type AdmissionPolicy = {
  acceptedTypes: readonly string[]
  minPriority: MessagePriority
}

export type AdmissionResult = {
  admitted: readonly CollaborationCandidate[]
  filtered: readonly string[]
}

const PRIORITY_RANK: Record<MessagePriority, number> = {
  normal: 0,
  high: 1,
  urgent: 2
}

export function admitCandidates(
  candidates: readonly CollaborationCandidate[],
  policy: AdmissionPolicy
): AdmissionResult {
  if (policy.acceptedTypes.length === 0) {
    return { admitted: [], filtered: candidates.map((c) => c.id) }
  }
  const accepted = new Set(policy.acceptedTypes)
  const minRank = PRIORITY_RANK[policy.minPriority]
  const admitted: CollaborationCandidate[] = []
  const filtered: string[] = []
  for (const candidate of candidates) {
    const { type, priority } = candidate.message
    if (accepted.has(type) && PRIORITY_RANK[priority] >= minRank) {
      admitted.push(candidate)
    } else {
      filtered.push(candidate.id)
    }
  }
  admitted.sort((a, b) => PRIORITY_RANK[b.message.priority] - PRIORITY_RANK[a.message.priority])
  return { admitted, filtered }
}
