import { runProcess } from '../../shared/child-process/run-process'
import {
  probeAgentProcessPresence,
  type AgentProcessObservation
} from '../../shared/agent-process-presence-probe'
import type { AgentProcessIdentity, AgentProcessVerdict } from '../../shared/agent-process-presence'

// Why 32: one bounded `ps` argv and output per tick, however many agents a host runs.
export const AGENT_PRESENCE_BATCH_LIMIT = 32
// Why 8: measured on macOS, `ps -p` with several PIDs scans the whole table (~80 ms) while one
// PID costs ~2-4 ms, so a few agents are cheaper probed one at a time.
export const AGENT_PRESENCE_SINGLE_PROBE_LIMIT = 8
const BATCH_TIMEOUT_MS = 1000

export type AgentPresenceBatchDeps = {
  platform: NodeJS.Platform
  /** macOS: one `ps -p <pids>` in the probe's pinned UTC/C format; null when unreadable. */
  readDarwinBatch: (pids: readonly number[]) => Promise<Map<number, AgentProcessObservation> | null>
  probeOne: (identity: AgentProcessIdentity) => Promise<AgentProcessVerdict>
  isMissing: (pid: number) => boolean
}

async function readDarwinBatch(
  pids: readonly number[]
): Promise<Map<number, AgentProcessObservation> | null> {
  const result = await runProcess({
    program: '/bin/ps',
    args: ['-p', pids.join(','), '-o', 'pid=,stat=,lstart='],
    // Why: the same zone/locale as the canonical identity reader, so start strings compare.
    env: { ...process.env, TZ: 'UTC0', LC_ALL: 'C', LANG: 'C' },
    timeoutMs: BATCH_TIMEOUT_MS,
    maxOutputBytes: 64 * 1024
  })
  // Why code 1 is fine: ps exits 1 when some requested pids are gone but prints the live ones.
  if (result.timedOut || (result.code !== 0 && result.code !== 1)) {
    return null
  }
  const observed = new Map<number, AgentProcessObservation>()
  for (const line of result.stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line)
    if (match) {
      observed.set(Number(match[1]), {
        verdict: 'live',
        startTime: match[3],
        zombie: match[2].startsWith('Z'),
        stopped: match[2].startsWith('T')
      })
    }
  }
  return observed
}

function isMissing(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'ESRCH'
  }
}

const DEFAULT_DEPS: AgentPresenceBatchDeps = {
  platform: process.platform,
  readDarwinBatch,
  probeOne: (identity) => probeAgentProcessPresence(identity),
  isMissing
}

function verdictFor(
  identity: AgentProcessIdentity,
  observed: AgentProcessObservation | undefined,
  missing: boolean
): AgentProcessVerdict {
  if (!observed) {
    return missing ? 'exited' : 'unverifiable'
  }
  if (observed.verdict !== 'live') {
    return observed.verdict
  }
  if (observed.zombie || observed.startTime !== identity.startTime) {
    return 'exited'
  }
  // Why: a stopped (Ctrl-Z) agent still exists; it is not proof of an exit.
  return observed.stopped ? 'unverifiable' : 'live'
}

/**
 * Targeted presence of known agent processes on this host: macOS reads up to 8 PIDs one at a time
 * and batches larger sets 32 per bounded `ps`; Linux reads `/proc` per PID. Never a table capture.
 */
export async function probeAgentProcessPresenceBatch(
  identities: readonly AgentProcessIdentity[],
  deps: AgentPresenceBatchDeps = DEFAULT_DEPS
): Promise<AgentProcessVerdict[]> {
  if (deps.platform !== 'darwin') {
    return Promise.all(
      identities.map((identity) => deps.probeOne(identity).catch(() => 'unverifiable' as const))
    )
  }
  const verdicts: AgentProcessVerdict[] = []
  if (identities.length <= AGENT_PRESENCE_SINGLE_PROBE_LIMIT) {
    // Why one at a time: never more than one probe subprocess in flight per host.
    for (const identity of identities) {
      verdicts.push(await deps.probeOne(identity).catch(() => 'unverifiable' as const))
    }
    return verdicts
  }
  for (let start = 0; start < identities.length; start += AGENT_PRESENCE_BATCH_LIMIT) {
    const chunk = identities.slice(start, start + AGENT_PRESENCE_BATCH_LIMIT)
    const observed = await deps
      .readDarwinBatch(chunk.map((identity) => identity.pid))
      .catch(() => null)
    for (const identity of chunk) {
      verdicts.push(
        observed === null || identity.platform !== 'darwin'
          ? 'unverifiable'
          : verdictFor(
              identity,
              observed.get(identity.pid),
              !observed.has(identity.pid) && deps.isMissing(identity.pid)
            )
      )
    }
  }
  return verdicts
}
