import {
  getFreshProcessTableSnapshot,
  getProcessTableSnapshot,
  type ProcessTableRow
} from '../../shared/process-table-snapshot'

/**
 * Out-of-band answer to "is this daemon still hosting running terminals?".
 *
 * Deliberately never touches the daemon socket: the only caller asks precisely
 * because the daemon has already failed to answer over it, and a wedged daemon
 * cannot be asked to vouch for its own sessions. Replacing a daemon kills every
 * process it hosts, so that decision needs evidence that survives the wedge.
 *
 * 'unknown' is not "empty" — it means the process table could not be read, or did not
 * contain the daemon at all. It is not evidence of absence, and it is deliberately not
 * evidence of presence either: the only caller raises to preserve on 'owns-live-ptys' alone.
 *
 * What 'unknown' costs changed with the launcher: it no longer falls through to a kill, it
 * holds the daemon in degraded mode. So this module's job is now to spare the user that
 * degradation where it safely can, not to stand between them and a dead agent.
 */
export type DaemonPtyOwnership = 'owns-live-ptys' | 'no-live-ptys' | 'unknown'

export type DaemonPtyOwnershipDeps = {
  platform?: NodeJS.Platform
  readPosixProcessTable?: () => Promise<ProcessTableRow[]>
  readCachedPosixProcessTable?: () => Promise<ProcessTableRow[]>
  posixDeadlineMs?: number
}

/**
 * Why sampled twice: the load that wedges the daemon is the same load that can blind
 * the process-table read, so a single blind sample would lose the evidence exactly when
 * it matters most. Only blindness is retried — a conclusive answer is taken as given.
 * This runs only on the replace path, after ~60s of grace is already spent.
 */
export const PTY_OWNERSHIP_PROBE_ATTEMPTS = 2

/**
 * POSIX needs its own ceiling for the same reason: the shared reader's `ps` timeout does not
 * cover queueing behind an in-flight scan, and this runs on a launch that fails open.
 */
export const POSIX_OWNERSHIP_PROBE_DEADLINE_MS = 4_000

/** macos-tcc-login-shell.ts wraps every darwin terminal in this. */
const MACOS_LOGIN_WRAPPER_PREFIX = '/usr/bin/login '

function withDeadline<T>(work: Promise<T>, deadlineMs: number, onDeadline: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(onDeadline), deadlineMs)
    timer.unref?.()
    void work.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      () => {
        clearTimeout(timer)
        resolve(onDeadline)
      }
    )
  })
}

/**
 * The daemon opens PTYs for its own probes, and forkpty makes those session leaders too, so
 * process state alone cannot tell them from a hosted terminal. Each is a fixed, argument-less
 * command the daemon issues itself, so matching them exactly costs no real terminal.
 */
const DAEMON_SELF_SPAWNED_PTY_COMMANDS = [
  // pty-subprocess.ts checkPtySpawnHealth
  { program: 'sh', args: '-c exit 0' }
]

function isDaemonSelfSpawnedPty(row: Pick<ProcessTableRow, 'command'>): boolean {
  const command = row.command.trim()
  return DAEMON_SELF_SPAWNED_PTY_COMMANDS.some(({ program, args }) => {
    const suffix = ` ${args}`
    // Why the argv tail must match exactly: `sh -c` payloads are user-supplied, and treating
    // one as the daemon's own probe would discard proof that real work is running.
    if (!command.endsWith(suffix)) {
      return false
    }
    // Only the program may vary, and only by path, so compare its trailing segment rather
    // than the whole string.
    const executable = command.slice(0, command.length - suffix.length)
    return (executable.split('/').pop() ?? executable) === program
  })
}

/**
 * A PTY child is a session leader — forkpty() calls setsid() — which the daemon's plain
 * subprocesses (a `scutil` resolver probe, a stuck credential helper) never are.
 *
 * Zombies are excluded for a correlated reason: a wedged daemon cannot reap, so its
 * already-exited PTYs linger as <defunct> and would read as still running.
 */
function isLivePtySessionLeader(row: ProcessTableRow): boolean {
  // Lowercase 's' is only ever the session-leader flag; no process state code uses it.
  return !row.stat.startsWith('Z') && row.stat.includes('s') && !isDaemonSelfSpawnedPty(row)
}

/**
 * macOS wraps every terminal in `/usr/bin/login` for TCC attribution, and the wrapper can
 * outlive the shell it wrapped (#13764) — a session leader hosting nothing. Counting those
 * would hold a daemon whose sessions have all ended, on hosts where they accumulate by the
 * hundred. A wrapper still doing its job always has the shell it exec'd beneath it.
 */
function isStrandedLoginWrapper(
  row: ProcessTableRow,
  hasChildren: boolean,
  platform: NodeJS.Platform
): boolean {
  // Why darwin only: Orca wraps terminals in login(1) for TCC attribution on macOS and nowhere
  // else, so off darwin this pattern can only ever be a user's own login(1) — and one that is
  // still prompting for credentials has no child yet, which is exactly the shape excluded here.
  // Applied POSIX-wide it discarded real work to solve a macOS problem.
  return (
    platform === 'darwin' &&
    !hasChildren &&
    row.command.trim().startsWith(MACOS_LOGIN_WRAPPER_PREFIX)
  )
}

function collectLivePtyDescendants(
  rows: ProcessTableRow[],
  rootPid: number,
  platform: NodeJS.Platform
): ProcessTableRow[] {
  const childrenByPpid = new Map<number, ProcessTableRow[]>()
  for (const row of rows) {
    if (row.pid === rootPid) {
      continue
    }
    const siblings = childrenByPpid.get(row.ppid)
    if (siblings) {
      siblings.push(row)
    } else {
      childrenByPpid.set(row.ppid, [row])
    }
  }
  const visited = new Set<number>([rootPid])
  const queue: number[] = [rootPid]
  const live: ProcessTableRow[] = []
  while (queue.length > 0) {
    const pid = queue.shift() as number
    for (const child of childrenByPpid.get(pid) ?? []) {
      if (visited.has(child.pid)) {
        continue
      }
      visited.add(child.pid)
      queue.push(child.pid)
      if (
        isLivePtySessionLeader(child) &&
        !isStrandedLoginWrapper(child, childrenByPpid.has(child.pid), platform)
      ) {
        live.push(child)
      }
    }
  }
  return live
}

/** POSIX only; Windows abstains before this is reached. */
async function probeOnce(
  daemonPid: number,
  deps: DaemonPtyOwnershipDeps,
  /**
   * The cached table may stand in for a slow read when the answer we are protecting is
   * 'owns-live-ptys', but never when confirming emptiness: a confirmation drawn from the same
   * TTL-cached snapshot as the sample it confirms is one observation counted twice, and the
   * window it is meant to exclude — a login(1) wrapper whose shell has not appeared yet — is
   * shorter than the cache. Denied there, a slow read answers 'unknown', which holds.
   */
  allowCachedFallback = true
): Promise<DaemonPtyOwnership> {
  const deadlineMs = deps.posixDeadlineMs ?? POSIX_OWNERSHIP_PROBE_DEADLINE_MS
  const deadline = Date.now() + deadlineMs
  const remaining = (): number => Math.max(1, deadline - Date.now())
  const rows =
    (await withDeadline(
      (deps.readPosixProcessTable ?? getFreshProcessTableSnapshot)(),
      remaining(),
      null
    )) ??
    // Why fall back instead of answering 'unknown': the uncached reader queues behind the
    // scans every agent pane already drives, so the busiest host — the one this evidence
    // exists to protect — is the likeliest to blow the deadline on queueing alone. A table a
    // few hundred milliseconds old still shows whether this daemon has children, and going
    // blind here gets them killed. It shares the attempt's budget rather than doubling it,
    // so an attempt costs what the launch budget was told it costs.
    (allowCachedFallback
      ? await withDeadline(
          (deps.readCachedPosixProcessTable ?? getProcessTableSnapshot)(),
          remaining(),
          null
        )
      : null)
  // Why: a walk that never saw the root reports zero descendants for a process it
  // never examined. Only a root we actually observed can prove emptiness — and a read
  // that blew its deadline saw nothing at all.
  if (rows === null || !rows.some((row) => row.pid === daemonPid)) {
    return 'unknown'
  }
  return collectLivePtyDescendants(rows, daemonPid, deps.platform ?? process.platform).length > 0
    ? 'owns-live-ptys'
    : 'no-live-ptys'
}

/**
 * A session-leader descendant is positive proof that killing this daemon would destroy
 * running work. Descendants rather than direct children: macOS wraps every shell in
 * login(1) for TCC attribution, so the agent is a grandchild at best.
 */
export async function inspectDaemonPtyOwnership(
  daemonPid: number,
  deps: DaemonPtyOwnershipDeps = {}
): Promise<DaemonPtyOwnership> {
  const platform = deps.platform ?? process.platform
  // Why Windows gets no verdict at all: the POSIX signal is a property only a hosted terminal
  // has — forkpty makes it a session leader — and Windows has no equivalent, so the branch
  // that lived here could only count descendants. That reads a wedged daemon's orphaned
  // conpty hosts as live work, since ClosePseudoConsole runs on the daemon's own JS thread
  // and a daemon too wedged to answer is too wedged to reap them.
  //
  // Abstaining costs Windows nothing it had: this evidence can only ever raise 'unknown' to
  // 'occupied', and both already hold the daemon. A verdict here would only let Windows print
  // the more accurate of two identical outcomes, which is not worth guessing for.
  if (platform === 'win32') {
    return 'unknown'
  }
  let emptyAwaitingConfirmation = false
  for (let attempt = 0; attempt < PTY_OWNERSHIP_PROBE_ATTEMPTS; attempt++) {
    let sample: DaemonPtyOwnership
    try {
      // The confirming read must be its own observation, so it is denied the cached table.
      sample = await probeOnce(daemonPid, deps, !emptyAwaitingConfirmation)
    } catch {
      sample = 'unknown'
    }
    // Why a second look before accepting emptiness: a terminal contributes exactly
    // one session leader — on macOS the login wrapper — and it is invisible for the moment
    // between forkpty creating it and the shell appearing beneath it. One snapshot cannot tell
    // that from a wrapper whose shell has gone. Emptiness authorizes a kill, so it is the
    // answer worth paying a second read for; 'owns-live-ptys' needs no confirmation.
    if (sample === 'no-live-ptys' && !emptyAwaitingConfirmation) {
      emptyAwaitingConfirmation = true
      continue
    }
    if (sample !== 'unknown') {
      return sample
    }
  }
  // Why not 'no-live-ptys' here: reaching this means the confirming read went blind, and a
  // blind read cannot corroborate anything. Upgrading an unconfirmed emptiness to a definitive
  // one is exactly the "absence of proof is proof of absence" step this module exists to
  // refuse — and emptiness is the answer that authorizes a kill.
  return 'unknown'
}
