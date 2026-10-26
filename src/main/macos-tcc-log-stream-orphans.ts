import { runProcess } from '@orca/process-host'
import {
  parsePsArgsLine,
  splitCommandLineArgv,
  sweepProcessIdentities,
  type ProcessIdentityRow
} from './opencode/opencode-client-sweep'
import { LOG_PREDICATE } from './macos-tcc-prompt-watch'

// Match legacy builds that spawned log stream without a lifetime wrapper.
const LEGACY_LOG_STREAM_COMMAND = splitCommandLineArgv(
  ['/usr/bin/log', 'stream', '--predicate', LOG_PREDICATE, '--info', '--style', 'compact'].join(' ')
).join(' ')

// etime has one-second resolution; separate snapshots may straddle a tick.
const START_TIME_TOLERANCE_MS = 2_000

function isLegacyOrphan(row: ProcessIdentityRow): boolean {
  return row.ppid === 1 && row.argv.join(' ') === LEGACY_LOG_STREAM_COMMAND
}

/** Only legacy streams reparented to launchd qualify; live streams belong to their wrapper. */
export function findOrphanedTccLogStreams(
  rows: readonly ProcessIdentityRow[]
): ProcessIdentityRow[] {
  return rows.filter((row) => row.executable === '/usr/bin/log' && isLegacyOrphan(row))
}

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
      // Recheck identity immediately before signalling; the sweep joins separate ps snapshots.
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
    } catch {}
  }
  if (reclaimed > 0) {
    console.info(`[tcc-prompt-watch] reclaimed ${reclaimed} orphaned log stream process(es)`)
  }
  return reclaimed
}
