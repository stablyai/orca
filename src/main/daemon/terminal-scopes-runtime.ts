import { existsSync } from 'node:fs'
import { userManagerEnv } from './daemon-cgroup-scope'
import { warnWhenRealtimeTimeoutIsZero } from './daemon-rttime-limit'
import { setPtyActiveProcessLimit } from '../windows/windows-pty-job'
import { resolveTerminalScopes, type TerminalScopeRuntime } from './terminal-scopes'
import type { PtyProcessCeilingState } from '../../shared/pty-process-ceiling-state'

type DaemonLog = (event: string, details?: Record<string, unknown>) => void

let active: { scopes: TerminalScopeRuntime; log: DaemonLog } | null = null
let scopeCounter = 0

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
  // No ManagedOOMPreference on the daemon scope: uresourced <0.5.5 loops on its xattr rewrites and wedges systemd --user.
  if (process.platform === 'linux') {
    log(
      'terminal-scopes',
      'on' in resolved.scopes
        ? { slice: resolved.scopes.on.slice, properties: resolved.scopes.on.properties }
        : resolved.scopes
    )
  }
  if (resolved.memory) {
    // Report requested limits even on hosts that cannot enforce them.
    log('terminal-memory-limits', { platform: process.platform, ...resolved.memory })
  }
  warnWhenRealtimeTimeoutIsZero(log)
  return resolved.ceiling
}

export function setTerminalScopesForTest(
  scopes: TerminalScopeRuntime | null,
  log: DaemonLog = () => {}
): void {
  active = scopes ? { scopes, log } : null
}

/** Match Orca’s exact wrapper paths so an unrelated user systemd-run is not hidden. */
export function isTerminalScopeWrapper(processName: string): boolean {
  return (
    active !== null &&
    (processName === active.scopes.systemdRun || processName === active.scopes.envBinary)
  )
}

const SESSION_KEYS = ['DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR'] as const

/** Reach the verified user manager, then restore the shell’s session variables inside its terminal scope. */
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
  // systemd-run would recreate a stopped slice without its original binding or limits.
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
