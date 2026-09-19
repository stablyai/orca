/**
 * Escaping the service cgroup for the detached PTY daemon.
 *
 * `detached: true` buys the daemon its own POSIX process group, not its own cgroup: under a
 * combined unit (`orca-serve.service` / `orca-serve@<slot>`) it and its PTYs stay in the unit's
 * cgroup, and `systemctl stop`/`restart` SIGKILLs whatever is left there — immediately under
 * `KillMode=control-group`, and the instant the main process exits under `KillMode=mixed`
 * (`TimeoutStopSec` only applies while that main process is still alive). Either way every
 * live terminal dies, however well the daemon otherwise survives its parent.
 *
 * `systemd-run --user --scope` registers a transient scope under the invoking user's own systemd
 * manager and execs the command into it, so the daemon's cgroup becomes a *sibling* of the
 * unit's that no unit-scoped kill reaches; `--collect` drops the unit once it exits.
 *
 * That needs systemd as PID 1 and a reachable `--user` manager (a login session, or
 * `loginctl enable-linger <user>` for a service account). Everywhere else keeps the direct-fork
 * launch, so this module fails closed to "not supported" rather than guessing.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { runProcessSync, type ProcessResult } from '../../shared/child-process/run-process'

const SYSTEMD_RUN_BINARY = 'systemd-run'
const UNIT_NAME_PREFIX = 'orca-daemon-'
/** The marker that distinguishes "booted under systemd" from a plain container. A test seam so
 *  the capability tests stay hermetic off a systemd host. */
const SYSTEMD_BOOT_PATH = '/run/systemd/system'
/** Long enough for a local binary to print its version, short enough that a wedged systemd
 *  cannot stall the launch lane. */
const SYSTEMD_RUN_PROBE_TIMEOUT_MS = 2_000

/** The conventional per-UID runtime dir every login session (and `loginctl enable-linger`)
 *  provisions, from `getuid()` rather than from the environment. The exported functions'
 *  `canonicalRuntimeDir` parameters default to this so production uses the real path; tests
 *  inject a fake one. */
const CANONICAL_USER_RUNTIME_DIR =
  typeof process.getuid === 'function' ? `/run/user/${process.getuid()}` : null

/** systemd unit names are restricted to `[A-Za-z0-9:_.\-@]`; sanitize defensively even though
 *  `launchNonce` is already a UUID (hyphens and hex digits only). */
export function daemonScopeUnitName(launchNonce: string): string {
  return `${UNIT_NAME_PREFIX}${launchNonce.replace(/[^A-Za-z0-9:_.-]/g, '-')}`
}

/** `isSocket()`, not `existsSync()`: a stale file or leftover directory at `bus` can never be
 *  dialed as one. Cheapest approximation of "connectable" that keeps this probe side-effect-free. */
function hasReachableBus(runtimeDir: string): boolean {
  try {
    return statSync(join(runtimeDir, 'bus')).isSocket()
  } catch {
    return false
  }
}

/**
 * The `XDG_RUNTIME_DIR` that actually hosts this OS user's systemd `--user` bus: the canonical
 * per-UID path first, the process's own env var only as a fallback.
 *
 * Why not that env var first: `RuntimeDirectory=` hardening (`orca-serve@factory.service` on
 * mtl-02) makes systemd export `XDG_RUNTIME_DIR=/run/orca_serve/<slot>`, a private scratch dir
 * that shares the name but hosts no bus, alongside `DBUS_SESSION_BUS_ADDRESS=disabled:` — while
 * the real bus was live at `/run/user/<uid>` the whole time. Trusting the env var reported
 * "unsupported" on every host hardened that way. It stays as the fallback for hosts that have no
 * `/run/user/<uid>` but do have a working bus wherever they point.
 */
function resolveUserRuntimeDir(env: NodeJS.ProcessEnv, canonicalDir: string | null): string | null {
  if (canonicalDir && hasReachableBus(canonicalDir)) {
    return canonicalDir
  }
  if (env.XDG_RUNTIME_DIR && hasReachableBus(env.XDG_RUNTIME_DIR)) {
    return env.XDG_RUNTIME_DIR
  }
  return null
}

/**
 * Best-effort, side-effect-free capability probe. Never throws; any uncertainty resolves to
 * "not supported" so the caller falls back to the existing, already-proven direct-fork launch.
 *
 * Stays synchronous: `launchDaemonChild` attaches the readiness listener in the same tick it is
 * called, and an await here would move the spawn past that tick. The child-process chokepoint
 * covers this shape with `runProcessSync` (as `isPwshAvailable` does) so the probe still gets
 * the shared spawn decisions instead of re-deciding them with `execFileSync`.
 *
 * `systemdBootPath` and `runVersionProbe` are test seams: they default to the real boot marker
 * and `systemd-run --version` probe, and a test injects fakes so the capability probe never
 * consults the host's own systemd.
 */

/** The slice of `ProcessResult` the capability probe consumes; narrow so a test stub carries no
 *  stdout/stderr/signal baggage. */
type SystemdRunVersionProbe = (
  binary: string,
  timeoutMs: number
) => Pick<ProcessResult, 'code' | 'timedOut'>

function runSystemdRunVersionProbe(
  binary: string,
  timeoutMs: number
): Pick<ProcessResult, 'code' | 'timedOut'> {
  const { code, timedOut } = runProcessSync({
    program: binary,
    args: ['--version'],
    stdio: 'ignore',
    timeoutMs
  })
  return { code, timedOut }
}

export function isDurableDaemonScopeSupported(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  canonicalRuntimeDir: string | null = CANONICAL_USER_RUNTIME_DIR,
  systemdBootPath: string = SYSTEMD_BOOT_PATH,
  runVersionProbe: SystemdRunVersionProbe = runSystemdRunVersionProbe
): boolean {
  if (platform !== 'linux') {
    return false
  }
  if (!existsSync(systemdBootPath)) {
    // Not booted under systemd (e.g. a plain container without systemd as PID 1) — a unit
    // restart isn't the failure mode there, and systemd-run has nothing to talk to anyway.
    return false
  }
  if (!resolveUserRuntimeDir(env, canonicalRuntimeDir)) {
    // No reachable user bus/session at the real per-UID path or the process's own env var —
    // systemd-run --user would just fail to connect.
    return false
  }
  try {
    const probe = runVersionProbe(SYSTEMD_RUN_BINARY, SYSTEMD_RUN_PROBE_TIMEOUT_MS)
    // A non-zero exit is data here rather than a throw, and a timeout kill leaves an exit behind
    // that answers nothing — both mean "cannot be trusted to place the daemon in a scope".
    return probe.code === 0 && !probe.timedOut
  } catch {
    // Throws only when the binary could not be started at all.
    return false
  }
}

export type DurableDaemonScopeCommand = {
  command: string
  args: string[]
  env: NodeJS.ProcessEnv
}

/**
 * Wraps the daemon's real command line in `systemd-run --user --scope`, so the process that
 * ultimately execs into `execPath forkEntryPath ...scriptArgs` lands in its own transient scope
 * cgroup instead of inheriting the caller's.
 */
export function buildDurableDaemonScopeCommand(
  execPath: string,
  scriptArgs: string[],
  launchNonce: string,
  env: NodeJS.ProcessEnv,
  canonicalRuntimeDir: string | null = CANONICAL_USER_RUNTIME_DIR
): DurableDaemonScopeCommand {
  const runtimeDir = resolveUserRuntimeDir(env, canonicalRuntimeDir)
  return {
    command: SYSTEMD_RUN_BINARY,
    args: [
      '--user',
      '--scope',
      `--unit=${daemonScopeUnitName(launchNonce)}`,
      '--collect',
      '--quiet',
      '--',
      execPath,
      ...scriptArgs
    ],
    // Explicit, not inherited: the daemon must land in the same user manager the resolution
    // above just confirmed is reachable, regardless of what this spread `env`'s own
    // `XDG_RUNTIME_DIR` says (see `resolveUserRuntimeDir` for why that value can be wrong).
    env: runtimeDir ? { ...env, XDG_RUNTIME_DIR: runtimeDir } : { ...env }
  }
}

/**
 * The daemon's own cgroup membership, read from /proc rather than trusted from the launcher's
 * intent, so a daemon that fell back (or was adopted from before this fix) cannot misreport
 * isolation it does not have. The owning unit name when isolated; null when it sits in the
 * parent's service unit, is not on Linux, or has unreadable cgroup membership.
 */
export function detectOwnCgroupScopeUnit(
  platform: NodeJS.Platform = process.platform,
  cgroupPath = '/proc/self/cgroup'
): string | null {
  if (platform !== 'linux') {
    return null
  }
  let contents: string
  try {
    contents = readFileSync(cgroupPath, 'utf8')
  } catch {
    return null
  }
  for (const line of contents.split('\n')) {
    // cgroup v2 unified hierarchy: "0::/user.slice/.../orca-daemon-<nonce>.scope"
    // cgroup v1 systemd controller: "1:name=systemd:/user.slice/.../orca-daemon-<nonce>.scope"
    const last = line.split('/').at(-1)?.trim()
    if (last && last.startsWith(UNIT_NAME_PREFIX) && last.endsWith('.scope')) {
      return last
    }
  }
  return null
}
