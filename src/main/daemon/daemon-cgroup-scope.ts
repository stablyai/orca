// Detached process groups still inherit service cgroups; a separate user scope survives service shutdown.
// Keep launch probes synchronous so readiness listeners attach in the spawn tick.
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { runProcessSync } from '@orca/process-host'
import type { ProcessResult } from '@orca/process-host/process-spec'
import { removeChromiumDisabledSessionBus } from '../pty/chromium-session-bus-env'
import { cgroupPathFromProcLine, userManagerOutlivesCaller } from './daemon-user-manager-lifetime'

const SYSTEMD_RUN_BINARY = 'systemd-run'
const UNIT_NAME_PREFIX = 'orca-daemon-'
const SYSTEMD_BOOT_PATH = '/run/systemd/system'
const SYSTEMD_RUN_PROBE_TIMEOUT_MS = 2_000
const SYSTEMD_SCOPE_MIGRATION_TIMEOUT_MS = 5_000
const LEGACY_SCOPE_PREFIX = 'app-orca-'

// Resolve the per-UID runtime directory independently of service-hardened environment overrides.
const CANONICAL_USER_RUNTIME_DIR =
  typeof process.getuid === 'function' ? `/run/user/${process.getuid()}` : null

// Restrict unit names even when the caller supplies a non-UUID nonce.
export function daemonScopeUnitName(launchNonce: string): string {
  return `${UNIT_NAME_PREFIX}${launchNonce.replace(/[^A-Za-z0-9:_.-]/g, '-')}.scope`
}

// A leftover file or directory is not a user bus; check for a socket without connecting.
function hasReachableBus(runtimeDir: string): boolean {
  try {
    return statSync(join(runtimeDir, 'bus')).isSocket()
  } catch {
    return false
  }
}

// Prefer the real per-UID bus: service hardening may redirect XDG_RUNTIME_DIR to private scratch.
function resolveUserRuntimeDir(env: NodeJS.ProcessEnv, canonicalDir: string | null): string | null {
  if (canonicalDir && hasReachableBus(canonicalDir)) {
    return canonicalDir
  }
  if (env.XDG_RUNTIME_DIR && hasReachableBus(env.XDG_RUNTIME_DIR)) {
    return env.XDG_RUNTIME_DIR
  }
  return null
}

type SystemdRunVersionProbe = (
  binary: string,
  timeoutMs: number
) => Pick<ProcessResult, 'code' | 'timedOut'>

type SystemdScopeMigrationRunner = (
  command: DurableDaemonScopeCommand,
  timeoutMs: number
) => Pick<ProcessResult, 'code' | 'timedOut'>

function runSystemdRunVersionProbe(
  binary: string,
  timeoutMs: number
): Pick<ProcessResult, 'code' | 'timedOut'> {
  return runProcessSync({ program: binary, args: ['--version'], stdio: 'ignore', timeoutMs })
}

type ScopeProbeDeps = {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  canonicalRuntimeDir?: string | null
  systemdBootPath?: string
  runVersionProbe?: SystemdRunVersionProbe
  outlivesCaller?: () => boolean
}

// Explicit null disables the canonical directory; undefined uses the host default.
function resolveCanonicalRuntimeDir(deps: ScopeProbeDeps): string | null {
  return deps.canonicalRuntimeDir !== undefined
    ? deps.canonicalRuntimeDir
    : CANONICAL_USER_RUNTIME_DIR
}

export function isDurableDaemonScopeSupported(deps: ScopeProbeDeps = {}): boolean {
  const {
    env = process.env,
    platform = process.platform,
    systemdBootPath = SYSTEMD_BOOT_PATH,
    runVersionProbe = runSystemdRunVersionProbe,
    outlivesCaller = userManagerOutlivesCaller
  } = deps
  const canonicalRuntimeDir = resolveCanonicalRuntimeDir(deps)
  if (platform !== 'linux') {
    return false
  }
  if (!existsSync(systemdBootPath)) {
    return false
  }
  if (!resolveUserRuntimeDir(env, canonicalRuntimeDir)) {
    return false
  }
  if (!outlivesCaller()) {
    // A live user bus alone does not prove the manager survives logout.
    return false
  }
  try {
    const probe = runVersionProbe(SYSTEMD_RUN_BINARY, SYSTEMD_RUN_PROBE_TIMEOUT_MS)
    // Timeouts and non-zero exits cannot establish usable scope support.
    return probe.code === 0 && !probe.timedOut
  } catch {
    return false
  }
}

export function userManagerEnv(
  env: NodeJS.ProcessEnv,
  canonicalRuntimeDir: string | null = CANONICAL_USER_RUNTIME_DIR
): NodeJS.ProcessEnv {
  const runtimeDir = resolveUserRuntimeDir(env, canonicalRuntimeDir)
  const next: NodeJS.ProcessEnv = runtimeDir ? { ...env, XDG_RUNTIME_DIR: runtimeDir } : { ...env }
  removeChromiumDisabledSessionBus(next)
  return next
}

export type DurableDaemonScopeCommand = {
  command: string
  args: string[]
  env: NodeJS.ProcessEnv
}

export function isLegacyDaemonScopeUnit(unit: string | null): boolean {
  return unit?.startsWith(LEGACY_SCOPE_PREFIX) === true && unit.endsWith('.scope')
}

function cgroupPathFromProc(contents: string): string | null {
  const paths: { path: string; priority: number }[] = []
  for (const line of contents.split('\n')) {
    const fields = line.split(':')
    const path = cgroupPathFromProcLine(line)
    if (fields.length >= 3 && path) {
      const controllers = fields[1]?.split(',') ?? []
      const priority = fields[0] === '0' ? 0 : controllers.includes('name=systemd') ? 1 : 2
      paths.push({ path, priority })
    }
  }
  return paths.sort((left, right) => left.priority - right.priority)[0]?.path ?? null
}

function scopeUnitFromCgroupPath(path: string): string | null {
  const unit = path.split('/').at(-1)?.trim()
  return unit?.endsWith('.scope') ? unit : null
}

export type LegacyDaemonScopeProcesses = {
  unit: string
  pids: number[]
}

export function readLegacyDaemonScopeProcesses(
  pid: number,
  procRoot = '/proc',
  cgroupRoot = '/sys/fs/cgroup'
): LegacyDaemonScopeProcesses | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return null
  }
  try {
    const cgroup = readFileSync(join(procRoot, String(pid), 'cgroup'), 'utf8')
    const path = cgroupPathFromProc(cgroup)
    const unit = path ? scopeUnitFromCgroupPath(path) : null
    if (unit === null || !isLegacyDaemonScopeUnit(unit) || !path) {
      return null
    }
    const legacyUnit = unit
    const pids = readFileSync(join(cgroupRoot, path.replace(/^\/+/, ''), 'cgroup.procs'), 'utf8')
      .split(/\s+/)
      .map(Number)
      .filter((value) => Number.isSafeInteger(value) && value > 0)
    return pids.length > 0 ? { unit: legacyUnit, pids } : null
  } catch {
    return null
  }
}

export function buildLegacyScopeMigrationCommand(
  launchNonce: string,
  pids: readonly number[],
  env: NodeJS.ProcessEnv,
  canonicalRuntimeDir: string | null = CANONICAL_USER_RUNTIME_DIR
): DurableDaemonScopeCommand {
  const runtimeDir = resolveUserRuntimeDir(env, canonicalRuntimeDir)
  const migrationEnv: NodeJS.ProcessEnv = runtimeDir
    ? { ...env, XDG_RUNTIME_DIR: runtimeDir }
    : { ...env }
  // busctl prefers DBUS_SESSION_BUS_ADDRESS; service hardening may set it to disabled:.
  delete migrationEnv.DBUS_SESSION_BUS_ADDRESS
  return {
    command: 'busctl',
    args: [
      '--user',
      'call',
      'org.freedesktop.systemd1',
      '/org/freedesktop/systemd1',
      'org.freedesktop.systemd1.Manager',
      'StartTransientUnit',
      'ssa(sv)a(sa(sv))',
      daemonScopeUnitName(launchNonce),
      'fail',
      '1',
      'PIDs',
      'au',
      String(pids.length),
      ...pids.map(String),
      '0'
    ],
    env: migrationEnv
  }
}

export function migrateLegacyDaemonScope(
  pid: number,
  launchNonce: string,
  deps: ScopeProbeDeps & {
    readProcesses?: typeof readLegacyDaemonScopeProcesses
    runMigration?: SystemdScopeMigrationRunner
  } = {}
): boolean {
  const {
    env = process.env,
    platform = process.platform,
    readProcesses = readLegacyDaemonScopeProcesses,
    runMigration = (command, timeoutMs) =>
      runProcessSync({
        program: command.command,
        args: command.args,
        env: command.env,
        timeoutMs,
        stdio: 'ignore'
      })
  } = deps
  if (platform !== 'linux' || !isDurableDaemonScopeSupported(deps)) {
    return false
  }
  const legacy = readProcesses(pid)
  if (!legacy) {
    return false
  }
  try {
    const result = runMigration(
      buildLegacyScopeMigrationCommand(
        launchNonce,
        legacy.pids,
        env,
        resolveCanonicalRuntimeDir(deps)
      ),
      SYSTEMD_SCOPE_MIGRATION_TIMEOUT_MS
    )
    return result.code === 0 && !result.timedOut
  } catch {
    return false
  }
}

/** Place the daemon in a sibling user scope so unit-scoped parent shutdown cannot kill it. */
export function buildDurableDaemonScopeCommand(
  execPath: string,
  scriptArgs: string[],
  launchNonce: string,
  env: NodeJS.ProcessEnv,
  canonicalRuntimeDir: string | null = CANONICAL_USER_RUNTIME_DIR
): DurableDaemonScopeCommand {
  const runtimeDir = resolveUserRuntimeDir(env, canonicalRuntimeDir)
  const scopeEnv: NodeJS.ProcessEnv = runtimeDir
    ? { ...env, XDG_RUNTIME_DIR: runtimeDir }
    : { ...env }
  // sd-bus prefers this over XDG_RUNTIME_DIR and refuses Chromium's marker (#25580).
  removeChromiumDisabledSessionBus(scopeEnv)
  return {
    command: SYSTEMD_RUN_BINARY,
    args: [
      '--user',
      '--scope',
      `--unit=${daemonScopeUnitName(launchNonce)}`,
      '--property=TimeoutStopSec=5s',
      '--collect',
      '--quiet',
      '--',
      execPath,
      ...scriptArgs
    ],
    env: scopeEnv
  }
}

/** Verify a newly launched daemon's scope; migrated legacy scopes may also contain the GUI. */
export function ownFreshDaemonScope(
  freshScope: boolean,
  launchNonce: string | undefined,
  detectScope: () => string | null = detectOwnCgroupScopeUnit
): string | null {
  if (!freshScope || !launchNonce) {
    return null
  }
  const unit = daemonScopeUnitName(launchNonce)
  return detectScope() === unit ? unit : null
}

/** Read actual cgroup membership so fallback or adopted daemons cannot claim unproven isolation. */
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
    // Handle both v2 unified and v1 systemd-controller paths.
    const last = line.split('/').at(-1)?.trim()
    if (last && (last.startsWith(UNIT_NAME_PREFIX) || isLegacyDaemonScopeUnit(last))) {
      return last
    }
  }
  return null
}
