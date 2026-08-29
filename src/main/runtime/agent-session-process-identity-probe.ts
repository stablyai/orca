/**
 * PID-reuse-safe process identity probe for the single-writer lease.
 *
 * Pids are reused within minutes on a busy host, and reuse happens precisely in the recovery
 * case, so a bare pid match is never proof. Every element of the identity tuple is unavailable
 * somewhere — start time costs a CIM query on Windows and is missing in some containers, /proc
 * does not exist on macOS — so an exact but unanswerable identity stays fenced in `recovering`;
 * an ownerless, unattributable reservation enters `manual-recovery`.
 */

import type {
  AgentSessionIdentityMatchField,
  AgentSessionOwnerProbe
} from '../../shared/agent-session-lease-adjudication'
import type { AgentSessionProcessIdentity } from '../../shared/agent-session-record'
import { readWindowsProcessTableFresh } from '../windows/windows-process-table'
import {
  PROCESS_START_TIME_TOLERANCE_MS,
  readProcessStartIdentity,
  readProcessStartTimesMs,
  type ProcessStartIdentity
} from './process-start-identity'

export {
  PROCESS_START_TIME_TOLERANCE_MS,
  processStartIdentitiesMatch,
  readProcessStartIdentity,
  readProcessStartTimeMs,
  readProcessStartTimesMs,
  type ProcessStartIdentity
} from './process-start-identity'

export type AgentSessionProcessProbeDeps = {
  /** ESRCH means gone; EPERM means present but owned by another user. */
  isPidPresent?: (pid: number) => boolean
  readProcessStartTimeMs?: (pid: number, platform?: NodeJS.Platform) => Promise<number | null>
  readProcessStartIdentity?: (
    pid: number,
    platform?: NodeJS.Platform
  ) => Promise<ProcessStartIdentity | null>
  /** Token the running child echoed back through the adapter handshake or provider hook. */
  readEchoedSpawnToken?: (identity: AgentSessionProcessIdentity) => Promise<string | null>
  platform?: NodeJS.Platform
}

function defaultIsPidPresent(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // Why: only ESRCH proves absence; permission and transient host failures must fail closed.
    return (error as NodeJS.ErrnoException)?.code !== 'ESRCH'
  }
}

export type AgentSessionProcessBatchProbeDeps = Omit<
  AgentSessionProcessProbeDeps,
  'readProcessStartTimeMs' | 'readProcessStartIdentity'
> & {
  readProcessStartTimesMs?: (
    pids: readonly number[],
    platform?: NodeJS.Platform
  ) => Promise<Map<number, number | null>>
  readProcessStartIdentities?: (
    pids: readonly number[],
    platform?: NodeJS.Platform
  ) => Promise<Map<number, ProcessStartIdentity | null>>
}

async function readProcessStartIdentities(
  pids: readonly number[],
  platform: NodeJS.Platform
): Promise<Map<number, ProcessStartIdentity | null>> {
  const uniquePids = [...new Set(pids)]
  if (platform === 'win32') {
    try {
      const rows = await readWindowsProcessTableFresh()
      return new Map(
        uniquePids.map((pid) => {
          const row = rows.find((candidate) => candidate.pid === pid)
          const identity =
            row?.creationTimeMs === undefined
              ? null
              : {
                  timeMs: row.creationTimeMs,
                  ...(row.startTimeId === undefined ? {} : { exactId: row.startTimeId })
                }
          return [pid, identity] as const
        })
      )
    } catch {
      return new Map(uniquePids.map((pid) => [pid, null]))
    }
  }
  const times = await readProcessStartTimesMs(uniquePids, platform)
  return new Map(
    uniquePids.map((pid) => {
      const timeMs = times.get(pid) ?? null
      return [pid, timeMs === null ? null : { timeMs }] as const
    })
  )
}

export async function probeAgentSessionProcessIdentities(args: {
  identities: readonly AgentSessionProcessIdentity[]
  deps?: AgentSessionProcessBatchProbeDeps
}): Promise<AgentSessionOwnerProbe[]> {
  const deps = args.deps ?? {}
  const platform = deps.platform ?? process.platform
  const pids = args.identities
    .filter((identity) => identity.processStartTimeMs !== null)
    .map((identity) => identity.pid)
  const readStartIdentities =
    deps.readProcessStartIdentities ??
    (deps.readProcessStartTimesMs
      ? async (requestedPids: readonly number[], requestedPlatform?: NodeJS.Platform) => {
          const times = await deps.readProcessStartTimesMs!(requestedPids, requestedPlatform)
          return new Map(
            requestedPids.map((pid) => {
              const timeMs = times.get(pid) ?? null
              return [pid, timeMs === null ? null : { timeMs }] as const
            })
          )
        }
      : readProcessStartIdentities)
  const startIdentities = await readStartIdentities(pids, platform).catch(() => new Map())
  return Promise.all(
    args.identities.map((identity) =>
      probeAgentSessionProcessIdentity({
        identity,
        deps: {
          ...deps,
          platform,
          readProcessStartIdentity: async (pid) => startIdentities.get(pid) ?? null,
          readProcessStartTimeMs: async (pid) => startIdentities.get(pid)?.timeMs ?? null
        }
      })
    )
  )
}

/**
 * Probe one recorded owner. `observedExit` short-circuits everything: Orca watching that exact
 * process exit is the strongest evidence available.
 */
export async function probeAgentSessionProcessIdentity(args: {
  identity: AgentSessionProcessIdentity
  observedExit?: boolean
  deps?: AgentSessionProcessProbeDeps
}): Promise<AgentSessionOwnerProbe> {
  const { identity } = args
  const deps = args.deps ?? {}
  if (args.observedExit) {
    return { outcome: 'exit-observed' }
  }
  const isPidPresent = deps.isPidPresent ?? defaultIsPidPresent
  if (!isPidPresent(identity.pid)) {
    return { outcome: 'pid-absent' }
  }
  const matchedOn: AgentSessionIdentityMatchField[] = []
  const echoedToken = await deps.readEchoedSpawnToken?.(identity).catch(() => null)
  if (echoedToken !== null && echoedToken !== undefined) {
    if (echoedToken !== identity.spawnToken) {
      return { outcome: 'identity-mismatch', field: 'spawn-token' }
    }
    matchedOn.push('spawn-token')
  }
  if (identity.processStartTimeMs !== null) {
    const platform = deps.platform ?? process.platform
    const observedIdentity: ProcessStartIdentity | null = deps.readProcessStartIdentity
      ? await deps.readProcessStartIdentity(identity.pid, platform).catch(() => null)
      : deps.readProcessStartTimeMs
        ? await deps
            .readProcessStartTimeMs(identity.pid, platform)
            .then((timeMs) => (timeMs === null ? null : { timeMs }))
            .catch(() => null)
        : await readProcessStartIdentity(identity.pid, platform).catch(() => null)
    if (observedIdentity !== null) {
      const startTimeMatches = identity.processStartTimeId
        ? observedIdentity.exactId === identity.processStartTimeId
        : Math.abs(observedIdentity.timeMs - identity.processStartTimeMs) <=
          PROCESS_START_TIME_TOLERANCE_MS
      if (!startTimeMatches) {
        if (matchedOn.includes('spawn-token')) {
          // Why: contradictory evidence cannot prove that a token-authenticated child is dead.
          return { outcome: 'indeterminate', reason: 'process identity evidence contradicted' }
        }
        return { outcome: 'identity-mismatch', field: 'process-start-time' }
      }
      matchedOn.push('process-start-time')
    }
  }
  if (matchedOn.length === 0) {
    // Why: the pid exists and nothing PID-reuse-safe could be checked. Reporting a match here is
    // exactly the case that produces two writers on one provider session.
    return {
      outcome: 'indeterminate',
      reason: 'pid present but neither spawn token nor start time could be verified'
    }
  }
  return { outcome: 'identity-matched', matchedOn }
}

/**
 * Probe a reservation that has no recorded process. `reservation-unused` requires positive proof
 * that nothing started — no process carrying the token and no provider-side activity after the
 * reservation — not an assumption that the crash beat the spawn.
 */
export async function probeAgentSessionReservation(args: {
  spawnToken: string
  findProcessesWithSpawnToken: (spawnToken: string) => Promise<number[] | null>
  hasProviderActivitySinceReservation: () => Promise<boolean | null>
}): Promise<AgentSessionOwnerProbe> {
  const pids = await args.findProcessesWithSpawnToken(args.spawnToken).catch(() => null)
  if (pids === null) {
    return { outcome: 'indeterminate', reason: 'host could not enumerate spawn tokens' }
  }
  if (pids.length > 0) {
    return {
      outcome: 'indeterminate',
      reason: `reservation spawn token is live on ${pids.length} process(es)`
    }
  }
  const providerActivity = await args.hasProviderActivitySinceReservation().catch(() => null)
  if (providerActivity === null) {
    return { outcome: 'indeterminate', reason: 'provider activity since reservation is unknown' }
  }
  return providerActivity
    ? { outcome: 'indeterminate', reason: 'provider saw activity after the reservation' }
    : { outcome: 'reservation-unused' }
}
