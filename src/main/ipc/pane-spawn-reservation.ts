import { randomUUID } from 'node:crypto'
import type { SleepingAgentLaunchConfig } from '../../shared/agent-session-resume'
import type { PtySpawnDisposition } from '../../shared/pty-spawn-disposition'
import type { PtySpawnResult } from '../providers/types'

export type PaneSpawnReservationResult = {
  id: string
  spawnDisposition: PtySpawnDisposition
  spawnRetirementToken?: string
  launchConfig?: SleepingAgentLaunchConfig
} & Partial<PtySpawnResult>

export type PaneSpawnReservation = {
  promise: Promise<PaneSpawnReservationResult>
  resolve: (result: PaneSpawnReservationResult) => void
  reject: (error: unknown) => void
  creatorRetirementToken: string
  waiterRetirementTokens: Set<string>
}

type PaneSpawnRetirement = {
  ptyId: string
  tokens: Set<string>
}

// Paired clients share the provider operation but retain independent retirement authority.
const reservationsByScope = new Map<string, PaneSpawnReservation>()
const retirementsByToken = new Map<string, PaneSpawnRetirement>()

export function getPaneSpawnReservation(scope: string): PaneSpawnReservation | undefined {
  return reservationsByScope.get(scope)
}

export function reservePaneSpawn(scope: string): PaneSpawnReservation {
  let resolve!: (result: PaneSpawnReservationResult) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<PaneSpawnReservationResult>((promiseResolve, promiseReject) => {
    resolve = promiseResolve
    reject = promiseReject
  })
  promise.catch(() => {})
  const reservation = {
    promise,
    resolve,
    reject,
    creatorRetirementToken: randomUUID(),
    waiterRetirementTokens: new Set<string>()
  }
  reservationsByScope.set(scope, reservation)
  return reservation
}

function clearPaneSpawnReservation(scope: string, reservation: PaneSpawnReservation): void {
  if (reservationsByScope.get(scope) === reservation) {
    reservationsByScope.delete(scope)
  }
}

export function rejectPaneSpawnReservation(
  scope: string | null | undefined,
  reservation: PaneSpawnReservation | null | undefined,
  error: unknown
): void {
  if (!reservation) {
    return
  }
  reservation.reject(error)
  if (scope) {
    clearPaneSpawnReservation(scope, reservation)
  }
}

export function resolvePaneSpawnReservation<T extends PaneSpawnReservationResult>(
  scope: string | null | undefined,
  reservation: PaneSpawnReservation | null | undefined,
  response: T
): T & { spawnRetirementToken?: string } {
  if (!reservation) {
    return response
  }
  reservation.resolve(response)
  if (scope) {
    clearPaneSpawnReservation(scope, reservation)
  }
  if (response.spawnDisposition !== 'created' || reservation.waiterRetirementTokens.size === 0) {
    return response
  }
  const tokens = new Set([
    reservation.creatorRetirementToken,
    ...reservation.waiterRetirementTokens
  ])
  const retirement = { ptyId: response.id, tokens }
  for (const token of tokens) {
    retirementsByToken.set(token, retirement)
  }
  return { ...response, spawnRetirementToken: reservation.creatorRetirementToken }
}

export async function awaitPaneSpawnReservation(
  reservation: PaneSpawnReservation
): Promise<PaneSpawnReservationResult> {
  const token = randomUUID()
  reservation.waiterRetirementTokens.add(token)
  const result = await reservation.promise
  return {
    ...result,
    spawnDisposition: 'awaited',
    ...(result.spawnDisposition === 'created' ? { spawnRetirementToken: token } : {})
  }
}

export function adoptPaneSpawn(ptyId: string, token: string): boolean {
  const retirement = retirementsByToken.get(token)
  if (!retirement || retirement.ptyId !== ptyId) {
    return false
  }
  for (const participantToken of retirement.tokens) {
    retirementsByToken.delete(participantToken)
  }
  return true
}

export function releasePaneSpawn(ptyId: string, token: string): boolean {
  const retirement = retirementsByToken.get(token)
  if (!retirement || retirement.ptyId !== ptyId) {
    return false
  }
  retirementsByToken.delete(token)
  retirement.tokens.delete(token)
  if (retirement.tokens.size > 0) {
    return false
  }
  return true
}

export function forgetPaneSpawnRetirement(ptyId: string): void {
  const retirements = new Set(
    [...retirementsByToken.values()].filter((retirement) => retirement.ptyId === ptyId)
  )
  for (const retirement of retirements) {
    for (const token of retirement.tokens) {
      retirementsByToken.delete(token)
    }
  }
}
