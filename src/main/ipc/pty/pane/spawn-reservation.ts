import type { SleepingAgentLaunchConfig } from '../../../../shared/agent-session-resume'
import type { PtySpawnResult } from '../../../providers/types'

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

// Why: identical pane coordinates on different worktrees or hosts are independent owners.
export const paneSpawnReservationsByOwnerKey = new Map<string, PaneSpawnReservation>()
export type PendingRuntimePaneCreate = {
  count: number
  promise: Promise<void>
  resolve: () => void
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
  let resolve!: () => void
  const claim = {
    count: 1,
    promise: new Promise<void>((done) => {
      resolve = done
    }),
    resolve: () => resolve()
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
