import type { SleepingAgentLaunchConfig } from '../../../../shared/agent-session-resume'
import type { PtySpawnResult } from '../../../providers/pty-provider-contract'
import { isWorktreeTerminalsSleepingError } from '../../../runtime/worktree-terminals-sleeping-error'

export type PaneSpawnReservation = {
  promise: Promise<PaneSpawnReservationResult>
  resolve: (result: PaneSpawnReservationResult) => void
  reject: (error: unknown) => void
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

export function claimRuntimePaneCreate(ownerKey: string): () => void {
  const existing = pendingRuntimePaneCreatesByOwnerKey.get(ownerKey)
  if (existing) {
    existing.count += 1
    return () => releaseRuntimePaneCreate(ownerKey, existing)
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
  return () => releaseRuntimePaneCreate(ownerKey, claim)
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

export function noteRuntimePaneCreateResult(
  ownerKey: string | null | undefined,
  result: PaneSpawnReservationResult
): void {
  const claim = ownerKey ? pendingRuntimePaneCreatesByOwnerKey.get(ownerKey) : undefined
  if (claim) {
    claim.result = result
  }
}
