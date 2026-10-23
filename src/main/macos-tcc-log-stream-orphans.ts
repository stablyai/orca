import { runProcess } from '@orca/process-host'
import {
  parsePsArgsLine,
  splitCommandLineArgv,
  sweepProcessIdentities,
  type ProcessIdentityRow
} from './opencode/opencode-client-sweep'
import { LOG_PREDICATE } from './macos-tcc-prompt-watch'

/** The exact argv that Orca builds before the sh wrapper spawned `log stream` directly. */
const LEGACY_LOG_STREAM_COMMAND = splitCommandLineArgv(
  ['/usr/bin/log', 'stream', '--predicate', LOG_PREDICATE, '--info', '--style', 'compact'].join(' ')
).join(' ')

// Why: `etime` has 1 s resolution and two reads of it can straddle a tick.
const START_TIME_TOLERANCE_MS = 2_000

function isLegacyOrphan(row: ProcessIdentityRow): boolean {
  return row.ppid === 1 && row.argv.join(' ') === LEGACY_LOG_STREAM_COMMAND
}

/**
 * Why: older builds left this `log stream` running under launchd whenever Orca died
 * uncleanly, and those orphans outlive every later launch. A live watcher's
 * `log stream` is parented by its wrapper, so only launchd's children (ppid 1) match.
 * `executable` comes from a later `ps` than argv, so a pid recycled between them fails.
 */
export function findOrphanedTccLogStreams(
  rows: readonly ProcessIdentityRow[]
): ProcessIdentityRow[] {
  return rows.filter((row) => row.executable === '/usr/bin/log' && isLegacyOrphan(row))
}

/** One-snapshot re-read of a single pid, so its ppid, start time and argv agree. */
async function readProcessIdentity(pid: number): Promise<ProcessIdentityRow | null> {
  const result = await runProcess({
    program: 'ps',
    args: ['-o', 'pid=,ppid=,etime=,args=', '-p', String(pid)],
    timeoutMs: 5_000
  })
  return result.code === 0 && !result.timedOut ? parsePsArgsLine(result.stdout, Date.now()) : null
}

export async function reclaimOrphanedTccLogStreams(
  deps: {
    platform?: NodeJS.Platform
    sweep?: () => Promise<ProcessIdentityRow[]>
    readProcess?: (pid: number) => Promise<ProcessIdentityRow | null>
    kill?: (pid: number, signal: NodeJS.Signals) => void
  } = {}
): Promise<number> {
  if ((deps.platform ?? process.platform) !== 'darwin') {
    return 0
  }
  const readProcess = deps.readProcess ?? readProcessIdentity
  const kill = deps.kill ?? ((pid, signal) => process.kill(pid, signal))
  let reclaimed = 0
  for (const candidate of findOrphanedTccLogStreams(
    await (deps.sweep ?? sweepProcessIdentities)()
  )) {
    try {
      // Why: the sweep joins two `ps` snapshots, so re-read right before signalling
      // and skip anything whose identity changed or can no longer be confirmed.
      const current = await readProcess(candidate.pid)
      if (
        !current ||
        !isLegacyOrphan(current) ||
        Math.abs(current.startedAtMs - candidate.startedAtMs) > START_TIME_TOLERANCE_MS
      ) {
        continue
      }
      kill(candidate.pid, 'SIGTERM')
      reclaimed++
    } catch {
      // Already gone, or another user's process.
    }
  }
  if (reclaimed > 0) {
    console.info(`[tcc-prompt-watch] reclaimed ${reclaimed} orphaned log stream process(es)`)
  }
  return reclaimed
}
