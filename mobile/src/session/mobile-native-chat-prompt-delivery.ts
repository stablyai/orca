import { sha256 } from '@noble/hashes/sha256'
import type { AgentPromptSubmissionOccurrence } from '../../../src/shared/agent-status-types'

export const MOBILE_NATIVE_CHAT_DELIVERY_CONFIRMATION_MS = 8_000

export type MobileNativeChatDeliveryCheck = {
  pendingId: string
  draftKey: string
  pendingKey: string | null
  text: string
  normalizedText: string
  baselineTailMessageId: string | null
  expectedDigest: string
  baseline?: AgentPromptSubmissionOccurrence
  deadline: ReturnType<typeof setTimeout> | null
  acknowledgedBy?: AgentPromptSubmissionOccurrence
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function mobileNativeChatPromptDigest(text: string): string {
  return `sha256:${bytesToHex(sha256(new TextEncoder().encode(text)))}`
}

export function mobileNativeChatPromptWasAcknowledged(
  check: MobileNativeChatDeliveryCheck,
  occurrences: readonly AgentPromptSubmissionOccurrence[]
): boolean {
  return occurrences.some((occurrence) => {
    if (occurrence.digest !== check.expectedDigest) {
      return false
    }
    if (!check.baseline) {
      return true
    }
    if (occurrence.streamId === check.baseline.streamId) {
      return occurrence.sequence > check.baseline.sequence
    }
    return occurrence.receivedAt > check.baseline.receivedAt
  })
}

function occurrenceKey(occurrence: AgentPromptSubmissionOccurrence): string {
  return `${occurrence.streamId}\0${occurrence.sequence}`
}

/** Assign each hook occurrence to at most one pending send. */
export function assignMobileNativeChatPromptSubmissions(
  checks: readonly MobileNativeChatDeliveryCheck[],
  occurrences: readonly AgentPromptSubmissionOccurrence[]
): Map<string, AgentPromptSubmissionOccurrence> {
  const assignments = new Map<string, AgentPromptSubmissionOccurrence>()
  const claimed = new Set<string>()
  for (const check of checks) {
    if (check.acknowledgedBy) {
      assignments.set(check.pendingId, check.acknowledgedBy)
      claimed.add(occurrenceKey(check.acknowledgedBy))
    }
  }
  for (const check of checks) {
    if (check.acknowledgedBy) {
      continue
    }
    const occurrence = occurrences.find(
      (item) =>
        !claimed.has(occurrenceKey(item)) && mobileNativeChatPromptWasAcknowledged(check, [item])
    )
    if (occurrence) {
      assignments.set(check.pendingId, occurrence)
      claimed.add(occurrenceKey(occurrence))
    }
  }
  return assignments
}
