import type {
  PtyProcessInspectionSource,
  PtyProcessLivenessEvidence
} from './pty-process-inspection'

export type PtyProcessEvidenceEntry = {
  source: PtyProcessInspectionSource
  identity: string
  unscopedProbe: boolean
  consumerIds: Set<string>
  hasUnscopedConsumer: boolean
  freshness: number
  owningInventoryObservedPty: boolean
  failureCount: number
  evidence: PtyProcessLivenessEvidence | null
  expiresAt: number
  timedOut: boolean
  probe: Promise<PtyProcessLivenessEvidence> | null
}

export type PtyProcessLivenessBrokerOptions = {
  timeoutMs: number
  maxConcurrentProbes?: number
  maxConcurrentUnscopedProbes?: number
  liveTtlMs?: number
  unavailableBackoffBaseMs?: number
  unavailableBackoffMaxMs?: number
  now?: () => number
  onInspectionError?: (ptyId: string, error: unknown) => void
}
