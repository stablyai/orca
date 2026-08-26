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

export function isCollaborationMessageAdmitted(
  message: CollaborationMessage,
  policy: AdmissionPolicy
): boolean {
  return (
    policy.acceptedTypes.includes(message.type) &&
    PRIORITY_RANK[message.priority] >= PRIORITY_RANK[policy.minPriority]
  )
}

export function admitCandidates(
  candidates: readonly CollaborationCandidate[],
  policy: AdmissionPolicy
): AdmissionResult {
  const admitted: CollaborationCandidate[] = []
  const filtered: string[] = []
  for (const candidate of candidates) {
    if (isCollaborationMessageAdmitted(candidate.message, policy)) {
      admitted.push(candidate)
    } else {
      filtered.push(candidate.id)
    }
  }
  admitted.sort((a, b) => PRIORITY_RANK[b.message.priority] - PRIORITY_RANK[a.message.priority])
  return { admitted, filtered }
}
