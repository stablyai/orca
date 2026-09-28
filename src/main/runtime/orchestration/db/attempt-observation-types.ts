export type AttemptObservationFacet =
  | 'process_turn'
  | 'artifact_git'
  | 'worker_report'
  | 'coordinator_ack'
  | 'liveness'
  | 'outcome'

export type AttemptProcessTurnObservation = {
  process: 'running' | 'stopped' | 'unknown'
  turn: 'working' | 'waiting' | 'finished' | 'unknown'
  quiet?: boolean
}

export type AttemptArtifactGitEvidence = {
  artifacts: 'present' | 'absent' | 'unknown'
  git: 'changed' | 'clean' | 'unknown'
}

export type AttemptWorkerReport =
  | {
      status: 'accepted'
      outcome: 'succeeded' | 'failed'
      reportId?: string
      late?: boolean
    }
  | {
      status: 'rejected' | 'missing'
      reason?: string
      reportId?: string
      late?: boolean
    }

export type AttemptCoordinatorAcknowledgment = {
  status: 'pending' | 'acknowledged'
  reportId?: string
}

export type AttemptLivenessObservation = PtyLivenessVerdict

export type AttemptAdditiveOutcomeFact = {
  outcome: 'outcome_unknown' | 'finished_unverified'
  reason: string
}

export type AttemptObservationPayloadByFacet = {
  process_turn: AttemptProcessTurnObservation
  artifact_git: AttemptArtifactGitEvidence
  worker_report: AttemptWorkerReport
  coordinator_ack: AttemptCoordinatorAcknowledgment
  liveness: AttemptLivenessObservation
  outcome: AttemptAdditiveOutcomeFact
}

type AttemptObservationInputBase<F extends AttemptObservationFacet> = {
  id: string
  dispatchId: string
  sequence: number
  authorityId: string
  authorityClock: 'execution' | 'home'
  facet: F
  payload: AttemptObservationPayloadByFacet[F]
  sourceObservedAt?: number | null
  executionReceivedAt?: number | null
  homeReceivedAt: number
}

export type AttemptObservationFactInput = {
  [F in AttemptObservationFacet]: AttemptObservationInputBase<F>
}[AttemptObservationFacet]

export type AttemptObservationFact = AttemptObservationFactInput & {
  taskId: string
  createdAt: string
}

export type AttemptProjectedOutcome =
  | 'in_progress'
  | 'succeeded'
  | 'failed'
  | 'outcome_unknown'
  | 'finished_unverified'

export type AttemptFreshness =
  | { status: 'never' }
  | { status: 'unverifiable'; clock: 'execution' | 'home' }
  | { status: 'future'; clock: 'execution' | 'home'; observedAt: number }
  | {
      status: 'fresh' | 'stale'
      clock: 'execution' | 'home'
      observedAt: number
      ageMs: number
    }

export type AttemptOutcomeProjection = {
  dispatchId: string
  taskId: string
  outcome: AttemptProjectedOutcome
  taskOutcome: AttemptProjectedOutcome
  outcomeSource: 'worker_report' | 'additive_fact' | 'observation' | 'none'
  outcomeReason: string | null
  activeSibling: boolean
  processTurn: AttemptProcessTurnObservation | null
  artifactGit: AttemptArtifactGitEvidence | null
  workerReport: AttemptWorkerReport | null
  coordinatorAcknowledgment: AttemptCoordinatorAcknowledgment | null
  liveness: AttemptLivenessObservation & { freshness: AttemptFreshness }
}
import type { PtyLivenessVerdict } from '../../../../shared/pty-liveness-verdict'
