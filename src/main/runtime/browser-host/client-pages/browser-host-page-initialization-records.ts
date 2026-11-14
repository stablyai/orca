import type {
  BrowserClientHostedPageInventory,
  BrowserClientHostLeaseAuthority
} from '../../../../shared/browser/client-hosting/browser-client-host-protocol'
import type { RuntimeBrowserClientPlacement } from '../../../../shared/runtime-browser-placement'
import type { BrowserHostLeaseState } from '../leases/browser-host-lease-records'
import type { BrowserClientPagePlacementReservation } from '../reconciliation/browser-host-page-placement'

export type InitializationOutcome =
  | 'prepared'
  | 'published'
  | 'retained-clean'
  | 'disposed'
  | 'cleanup-unknown'
  | 'route-parked'

export type InitializationDisposition =
  | 'queued'
  | 'joined-existing'
  | 'successor-pending'
  | 'closed'
  | 'stale'

export type InitializationTarget = BrowserClientHostLeaseAuthority & {
  pageHostGeneration: number
}

export type BrowserHostPageInitializationInput = {
  browserPageId: string
  browserProfileId: string
  workspaceId: string
  expected: RuntimeBrowserClientPlacement
  url: string
  pageHostGeneration?: number
  previous?: BrowserClientHostedPageInventory
  creationTimeoutMs?: number
  closeTimeoutMs?: number
  signal?: AbortSignal
  replace?: boolean
  changed?(): void
  claim?(): void
  isCurrent(): boolean
  resolveExecutionHostKey(): Promise<string | null>
  publish(placement: RuntimeBrowserClientPlacement, url: string, executionHostKey: string): void
  settled?(outcome: InitializationOutcome): void
  completed?(url?: string): void
}

export type InitializationAdmission = {
  state: BrowserHostLeaseState
  connectionToken: symbol
  input: BrowserHostPageInitializationInput
  reservation?: BrowserClientPagePlacementReservation
  removeAbort(): void
}

export type Initialization = {
  admission: InitializationAdmission
  record: InitializationRecord
  controller: AbortController
  running: boolean
  executing: boolean
  detached: boolean
  phase: 'cleanup' | 'waiting' | 'create' | 'published'
  executionHostKey?: string
  removePreparation?: () => void
  cleanupFailed?: boolean
  cleanupRequested?: symbol
  cleanupAttempt?: {
    target: InitializationTarget
    connectionToken: symbol
    closed: boolean
    stopped: boolean
  }
  preserveContinuation?(): boolean
  retiredTarget?: InitializationTarget
  releaseGrant?: () => void
  closing?: { target: InitializationTarget; absent: () => void; result: Promise<void> }
}

export type InitializationRecord = {
  browserPageId: string
  browserProfileId: string
  workspaceId: string
  expected: RuntimeBrowserClientPlacement
  pairedDeviceId: string
  browserHostClientId: string
  closed: boolean
  authorityRetired: boolean
  legacyAttempt?: { state: BrowserHostLeaseState; cancel(): void }
  stopped?: boolean
  scope?: BrowserHostLeaseState
  releaseCleanup?: () => void
  target?: InitializationTarget
  targetExecutionHostKey?: string
  operation?: Initialization
  successor?: InitializationAdmission
  observer?: InitializationAdmission
}

export type InitializationQueue = {
  pending: Initialization[]
  active: number
  scheduled: boolean
}

export function sameInitializationTarget(
  left: InitializationTarget | undefined,
  right: InitializationTarget | undefined
): boolean {
  return Boolean(
    left &&
    right &&
    left.authorityRuntimeId === right.authorityRuntimeId &&
    left.authorityEpoch === right.authorityEpoch &&
    left.browserHostClientId === right.browserHostClientId &&
    left.browserHostGeneration === right.browserHostGeneration &&
    left.pageHostGeneration === right.pageHostGeneration
  )
}

export function sameInitializationPlacement(
  left: {
    kind: string
    browserHostClientId?: string
    browserHostGeneration?: number
    pageHostGeneration?: number
  },
  right: RuntimeBrowserClientPlacement
): left is RuntimeBrowserClientPlacement {
  return (
    left.kind === 'client' &&
    left.browserHostClientId === right.browserHostClientId &&
    left.browserHostGeneration === right.browserHostGeneration &&
    left.pageHostGeneration === right.pageHostGeneration
  )
}

export function notifyInitialization(
  record: InitializationRecord,
  outcome: InitializationOutcome
): void {
  const observer = record.observer
  if (
    observer &&
    !observer.input.signal?.aborted &&
    observer.connectionToken === observer.state.connectionToken
  ) {
    observer.input.settled?.(outcome)
  }
}

export function canContinueInitialization(
  record: InitializationRecord | undefined,
  expected: RuntimeBrowserClientPlacement,
  lease: { pairedDeviceId: string },
  live: unknown
): boolean {
  return Boolean(
    record?.authorityRetired &&
    !record.closed &&
    record.pairedDeviceId === lease.pairedDeviceId &&
    sameInitializationPlacement(record.expected, expected) &&
    !live
  )
}

export function initializationCleanupServesCurrentDemand(operation: Initialization): boolean {
  const attempt = operation.cleanupAttempt
  return Boolean(
    attempt &&
    sameInitializationTarget(attempt.target, operation.record.target) &&
    attempt.connectionToken === operation.admission.state.connectionToken &&
    attempt.closed === operation.record.closed &&
    attempt.stopped === Boolean(operation.record.stopped)
  )
}

/** A reconnect can transfer command intent, never a predecessor's cleanup input. */
export function currentInitializationRequest(
  record: InitializationRecord | undefined,
  state: BrowserHostLeaseState
): InitializationAdmission | undefined {
  if (
    !record ||
    record.closed ||
    record.stopped ||
    record.authorityRetired ||
    record.pairedDeviceId !== state.lease.pairedDeviceId
  ) {
    return undefined
  }
  const operation = record.operation
  const admission =
    record.successor ??
    (operation &&
    !operation.detached &&
    !operation.controller.signal.aborted &&
    operation.phase !== 'published'
      ? operation.admission
      : undefined)
  const input = admission?.input
  return admission &&
    input &&
    !input.signal?.aborted &&
    input.isCurrent() &&
    input.workspaceId === record.workspaceId &&
    input.browserProfileId === record.browserProfileId &&
    admission.state.lease.pairedDeviceId === record.pairedDeviceId &&
    sameInitializationPlacement(input.expected, record.expected)
    ? admission
    : undefined
}
