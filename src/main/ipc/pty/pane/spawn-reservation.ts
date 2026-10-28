import type { SleepingAgentLaunchConfig } from '../../../../shared/agent-session-resume'
import type { PtySpawnResult } from '../../../providers/pty-provider-contract'
import { isWorktreeTerminalsSleepingError } from '../../../runtime/worktree-terminals-sleeping-error'
import type { PtySpawnOutcome } from '../spawn-outcome'
import type { PaneSpawnOperation } from './pane-spawn-operation'

export type PaneSpawnReservation = {
  promise: Promise<PaneSpawnReservationResult>
  resolve: (result: PaneSpawnReservationResult) => void
  reject: (error: unknown) => void
  outcome?: PtySpawnOutcome
  operation?: PaneSpawnOperation
}
export type PaneSpawnReservationResult = {
  id: string
  launchConfig?: SleepingAgentLaunchConfig
  stablePaneOwner?: {
    handle: string
    tabId: string
    leafId: string
  }
} & Partial<PtySpawnResult>

// Pane coordinates belong to independent owners across worktrees and execution hosts.
export const paneSpawnReservationsByOwnerKey = new Map<string, PaneSpawnReservation>()
export type PendingRuntimePaneCreate = {
  count: number
  promise: Promise<PaneSpawnReservationResult | undefined>
  resolve: () => void
  /** The terminal the create started, for a view that waited on it (layout-owner build). */
  result?: PaneSpawnReservationResult
  operation?: PaneSpawnOperation
}
export const pendingRuntimePaneCreatesByOwnerKey = new Map<string, PendingRuntimePaneCreate>()

export function reservePaneSpawn(paneKey: string): PaneSpawnReservation {
  let resolve!: (result: PaneSpawnReservationResult) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<PaneSpawnReservationResult>((promiseResolve, promiseReject) => {
    resolve = promiseResolve
    reject = promiseReject
  })
  promise.catch(() => {})
  const reservation = { promise, resolve, reject }
  paneSpawnReservationsByOwnerKey.set(paneKey, reservation)
  return reservation
}

/** Join a concurrent spawn; automatic slept-worktree refusal leaves a user wake free to start its own process. */
export async function joinPaneSpawn(
  reservation: PaneSpawnReservation
): Promise<PaneSpawnReservationResult | null> {
  try {
    return await reservation.promise
  } catch (error) {
    if (
      isWorktreeTerminalsSleepingError(error) ||
      (error instanceof Error && error.message === 'terminal_pane_unbound')
    ) {
      return null
    }
    throw error
  }
}

export async function reserveIdlePaneSpawn(ownerKey: string): Promise<PaneSpawnReservation> {
  for (;;) {
    const pendingCreate = pendingRuntimePaneCreatesByOwnerKey.get(ownerKey)
    if (pendingCreate) {
      await pendingCreate.promise
      continue
    }
    const pendingSpawn = paneSpawnReservationsByOwnerKey.get(ownerKey)
    if (pendingSpawn) {
      await pendingSpawn.promise.catch(() => {})
      continue
    }
    return reservePaneSpawn(ownerKey)
  }
}

export function clearPaneSpawnReservation(
  paneKey: string,
  reservation: PaneSpawnReservation
): void {
  if (paneSpawnReservationsByOwnerKey.get(paneKey) === reservation) {
    paneSpawnReservationsByOwnerKey.delete(paneKey)
  }
}

export function makePaneSpawnReservationKey(
  worktreeId: string | undefined,
  connectionId: string | null | undefined,
  paneKey: string | null | undefined
): string | null {
  return paneKey ? JSON.stringify([connectionId ?? null, worktreeId ?? null, paneKey]) : null
}

export type RuntimePaneCreateClaim = (() => void) & {
  acceptOutcome?: (outcome: PtySpawnOutcome, operation: PaneSpawnOperation) => void
}

export function claimRuntimePaneCreate(ownerKey: string): RuntimePaneCreateClaim {
  const existing = pendingRuntimePaneCreatesByOwnerKey.get(ownerKey)
  if (existing) {
    existing.count += 1
    return runtimePaneCreateRelease(ownerKey, existing)
  }
  let resolve!: (result: PaneSpawnReservationResult | undefined) => void
  const claim: PendingRuntimePaneCreate = {
    count: 1,
    promise: new Promise((done) => {
      resolve = done
    }),
    resolve: () => resolve(claim.result)
  }
  pendingRuntimePaneCreatesByOwnerKey.set(ownerKey, claim)
  return runtimePaneCreateRelease(ownerKey, claim)
}

function runtimePaneCreateRelease(ownerKey: string, claim: PendingRuntimePaneCreate) {
  return Object.assign(() => releaseRuntimePaneCreate(ownerKey, claim), {
    acceptOutcome: (outcome: PtySpawnOutcome, operation: PaneSpawnOperation) => {
      if (pendingRuntimePaneCreatesByOwnerKey.get(ownerKey) === claim && !claim.operation) {
        claim.operation = operation
        claim.result = outcome.result
      }
    }
  })
}

export function releaseRuntimePaneCreate(ownerKey: string, claim: PendingRuntimePaneCreate): void {
  if (pendingRuntimePaneCreatesByOwnerKey.get(ownerKey) !== claim) {
    return
  }
  claim.count -= 1
  if (claim.count > 0) {
    return
  }
  pendingRuntimePaneCreatesByOwnerKey.delete(ownerKey)
  claim.resolve()
}

export function rejectPaneSpawnReservation(
  paneKey: string | null | undefined,
  reservation: PaneSpawnReservation | null | undefined,
  error: unknown
): void {
  if (!reservation) {
    return
  }
  reservation.reject(error)
  if (paneKey) {
    clearPaneSpawnReservation(paneKey, reservation)
  }
}

export function resolvePaneSpawnReservation<T extends PaneSpawnReservationResult>(
  paneKey: string | null | undefined,
  reservation: PaneSpawnReservation | null | undefined,
  response: T
): T {
  if (!reservation) {
    return response
  }
  reservation.resolve(response)
  if (paneKey) {
    clearPaneSpawnReservation(paneKey, reservation)
  }
  return response
}
