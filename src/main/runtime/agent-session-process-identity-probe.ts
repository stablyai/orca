/**
 * PID-reuse-safe process identity probe for the single-writer lease.
 *
 * Pids are reused within minutes on a busy host, and reuse happens precisely in the recovery
 * case, so a bare pid match is never proof. Every element of the identity tuple is unavailable
 * somewhere — start time costs a CIM query on Windows and is missing in some containers, /proc
 * does not exist on macOS — so an exact but unanswerable identity stays fenced in `recovering`;
 * an ownerless, unattributable reservation enters `manual-recovery`.
 */

import { readFile } from 'node:fs/promises'
import type {
  AgentSessionIdentityMatchField,
  AgentSessionOwnerProbe
} from '../../shared/agent-session-lease-adjudication'
import type { AgentSessionProcessIdentity } from '../../shared/agent-session-record'
import { runProcess } from '../../shared/child-process/run-process'
import { readWindowsProcessTableFresh } from '../windows/windows-process-table'

/** Start times drift by scheduler granularity and clock reads; compare with a tolerance. */
export const PROCESS_START_TIME_TOLERANCE_MS = 2_000

const PROCESS_START_TIME_TIMEOUT_MS = 5_000

export type AgentSessionProcessProbeDeps = {
  /** ESRCH means gone; EPERM means present but owned by another user. */
  isPidPresent?: (pid: number) => boolean
  readProcessStartTimeMs?: (pid: number, platform?: NodeJS.Platform) => Promise<number | null>
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

async function readLinuxProcessStartTimeMs(pid: number): Promise<number | null> {
  try {
    const [stat, systemStat] = await Promise.all([
      readFile(`/proc/${pid}/stat`, 'utf-8'),
      readFile('/proc/stat', 'utf-8')
    ])
    // Field 22 is starttime in clock ticks; the comm field can contain spaces, so cut past ") ".
    const fields = stat.slice(stat.lastIndexOf(') ') + 2).split(' ')
    const ticks = Number(fields[19])
    const bootTimeSeconds = Number(/^btime\s+(\d+)$/m.exec(systemStat)?.[1])
    if (!Number.isFinite(ticks) || !Number.isFinite(bootTimeSeconds)) {
      return null
    }
    return Math.round(bootTimeSeconds * 1000 + (ticks / 100) * 1000)
  } catch {
    return null
  }
}

async function readDarwinProcessStartTimeMs(pid: number): Promise<number | null> {
  try {
    const result = await runProcess({
      program: 'ps',
      args: ['-o', 'lstart=', '-p', String(pid)],
      timeoutMs: PROCESS_START_TIME_TIMEOUT_MS
    })
    if (result.timedOut || result.code !== 0) {
      return null
    }
    const parsed = Date.parse(result.stdout.trim())
    return Number.isFinite(parsed) ? parsed : null
  } catch {
    return null
  }
}

async function readDarwinProcessStartTimesMs(
  pids: readonly number[]
): Promise<Map<number, number | null>> {
  const observed = new Map<number, number | null>()
  if (pids.length === 0) {
    return observed
  }
  try {
    const result = await runProcess({
      program: 'ps',
      args: ['-o', 'pid=,lstart=', '-p', pids.join(',')],
      timeoutMs: PROCESS_START_TIME_TIMEOUT_MS
    })
    if (result.timedOut || result.code !== 0) {
      return observed
    }
    for (const line of result.stdout.split('\n')) {
      const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(line)
      if (!match) {
        continue
      }
      const pid = Number(match[1])
      const parsed = Date.parse(match[2])
      if (Number.isSafeInteger(pid) && Number.isFinite(parsed)) {
        observed.set(pid, parsed)
      }
    }
  } catch {
    // A missing process table is unknown, never evidence that every owner exited.
  }
  return observed
}

async function readWindowsProcessStartTimeMs(pid: number): Promise<number | null> {
  try {
    const row = (await readWindowsProcessTableFresh()).find((candidate) => candidate.pid === pid)
    return row?.creationTimeMs ?? null
  } catch {
    return null
  }
}

/**
 * Process start time is the cross-platform PID-reuse guard when no provider hook can echo the
 * spawn token back to the owner probe.
 */
export async function readProcessStartTimeMs(
  pid: number,
  platform: NodeJS.Platform = process.platform
): Promise<number | null> {
  if (platform === 'linux') {
    return readLinuxProcessStartTimeMs(pid)
  }
  if (platform === 'darwin') {
    return readDarwinProcessStartTimeMs(pid)
  }
  if (platform === 'win32') {
    return readWindowsProcessStartTimeMs(pid)
  }
  return null
}

export async function readProcessStartTimesMs(
  pids: readonly number[],
  platform: NodeJS.Platform = process.platform
): Promise<Map<number, number | null>> {
  const uniquePids = [...new Set(pids)]
  if (platform === 'darwin') {
    const table = await readDarwinProcessStartTimesMs(uniquePids)
    return new Map(uniquePids.map((pid) => [pid, table.get(pid) ?? null]))
  }
  return new Map(
    await Promise.all(
      uniquePids.map(async (pid) => [pid, await readProcessStartTimeMs(pid, platform)] as const)
    )
  )
}

export type AgentSessionProcessBatchProbeDeps = Omit<
  AgentSessionProcessProbeDeps,
  'readProcessStartTimeMs'
> & {
  readProcessStartTimesMs?: (
    pids: readonly number[],
    platform?: NodeJS.Platform
  ) => Promise<Map<number, number | null>>
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
  const readStartTimes = deps.readProcessStartTimesMs ?? readProcessStartTimesMs
  const startTimes = await readStartTimes(pids, platform).catch(() => new Map())
  return Promise.all(
    args.identities.map((identity) =>
      probeAgentSessionProcessIdentity({
        identity,
        deps: {
          ...deps,
          platform,
          readProcessStartTimeMs: async (pid) => startTimes.get(pid) ?? null
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
    const readStartTime = deps.readProcessStartTimeMs ?? readProcessStartTimeMs
    const observed = await readStartTime(identity.pid, deps.platform ?? process.platform).catch(
      () => null
    )
    if (observed !== null) {
      if (Math.abs(observed - identity.processStartTimeMs) > PROCESS_START_TIME_TOLERANCE_MS) {
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
