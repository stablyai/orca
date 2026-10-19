/** The daemon's terminal scopes and process ceiling, applied to every PTY spawn it makes. */
import { existsSync } from 'node:fs'
import { spawnProcess } from '@orca/process-host'
import { userManagerEnv } from './daemon-cgroup-scope'
import { setPtyActiveProcessLimit } from '../windows/windows-pty-job'
import { resolveTerminalScopes, type TerminalScopeRuntime } from './terminal-scopes'
import type { PtyProcessCeilingState } from '../../shared/pty-process-ceiling-state'

type DaemonLog = (event: string, details?: Record<string, unknown>) => void

let active: { scopes: TerminalScopeRuntime; log: DaemonLog } | null = null
let scopeCounter = 0

/** Daemon start: decide, remember for every spawn, and return what the pid record reports. */
export function initializeTerminalScopes(
  daemonScope: string | null,
  log: DaemonLog
): PtyProcessCeilingState {
  const resolved = resolveTerminalScopes({
    env: process.env,
    platform: process.platform,
    daemonScope,
    setWindowsLimit: setPtyActiveProcessLimit
  })
  active = 'on' in resolved.scopes ? { scopes: resolved.scopes.on, log } : null
  if (active && daemonScope) {
    // Why best-effort: oomd should pick a terminal before the daemon that holds every
    // terminal's scrollback; older systemd ignores or rejects it, which changes nothing.
    try {
      const child = spawnProcess({
        program: 'systemctl',
        args: ['--user', 'set-property', '--runtime', daemonScope, 'ManagedOOMPreference=avoid'],
        env: userManagerEnv(process.env),
        stdio: 'ignore'
      })
      child.on('error', () => {})
      child.unref()
    } catch {
      // Only a spawn refused outright lands here; terminal scopes work without it.
    }
  }
  if (process.platform === 'linux') {
    log(
      'terminal-scopes',
      'on' in resolved.scopes
        ? { slice: resolved.scopes.on.slice, properties: resolved.scopes.on.properties }
        : resolved.scopes
    )
  }
  if (resolved.memory) {
    // Why log every platform: an operator who set a limit must learn when it did nothing.
    log('terminal-memory-limits', { platform: process.platform, ...resolved.memory })
  }
  return resolved.ceiling
}

export function setTerminalScopesForTest(
  scopes: TerminalScopeRuntime | null,
  log: DaemonLog = () => {}
): void {
  active = scopes ? { scopes, log } : null
}

/** Orca's own wrappers, by the exact argv[0] it execs them with; a user's `systemd-run` differs. */
export function isTerminalScopeWrapper(processName: string): boolean {
  return (
    active !== null &&
    (processName === active.scopes.systemdRun || processName === active.scopes.envBinary)
  )
}

const SESSION_KEYS = ['DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR'] as const

/**
 * Linux with terminal scopes: exec through `systemd-run --scope`, which keeps the pid and exit
 * status, into this terminal's own scope. `systemd-run` talks to the user manager the daemon
 * verified; `env` then gives the shell its own session variables back. Off, it is the identity.
 */
export function wrapPtySpawnInTerminalScope(
  file: string,
  args: string[],
  env: Record<string, string>,
  sliceExists: (path: string) => boolean = existsSync
): { file: string; args: string[]; env: Record<string, string> } {
  if (!active) {
    return { file, args, env }
  }
  const { scopes, log } = active
  // Why: `systemd-run --slice` would silently recreate a stopped slice unbound and unlimited.
  if (!sliceExists(scopes.sliceCgroupPath)) {
    active = null
    log('terminal-scopes-slice-lost', {
      message: 'terminal scope slice lost; later terminals stay in the daemon scope'
    })
    return { file, args, env }
  }
  scopeCounter += 1
  const managerEnv: Record<string, string> = {}
  for (const [key, value] of Object.entries(userManagerEnv(env))) {
    if (typeof value === 'string' && key !== 'DBUS_SESSION_BUS_ADDRESS') {
      managerEnv[key] = value
    }
  }
  const unsets: string[] = []
  const sets: string[] = []
  for (const key of SESSION_KEYS) {
    if (env[key] !== managerEnv[key]) {
      if (env[key] === undefined) {
        unsets.push('-u', key)
      } else {
        sets.push(`${key}=${env[key]}`)
      }
    }
  }
  return {
    file: scopes.systemdRun,
    args: [
      '--user',
      '--scope',
      '--quiet',
      '--collect',
      `--slice=${scopes.slice}`,
      `--unit=orca_pty_${scopes.launchId}_${scopeCounter}.scope`,
      ...scopes.properties.map((property) => `--property=${property}`),
      '--',
      ...(unsets.length + sets.length > 0 ? [scopes.envBinary, ...unsets, ...sets] : []),
      file,
      ...args
    ],
    env: managerEnv
  }
}
