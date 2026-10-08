import {
  spawnProcess,
  type ProcessSpec,
  type SpawnedProcess
} from '../../shared/child-process/run-process'
import { daemonScopeUnitName, detectOwnCgroupScopeUnit } from './daemon-cgroup-scope'

// The pipe closes even on SIGKILL; a live/reused owner PID always vetoes cleanup.
const SCOPE_DEATH_WATCH_SCRIPT = `
while IFS= read -r line; do :; done
attempt=0
while [ -d "/proc/$1" ]; do
  attempt=$((attempt + 1))
  [ "$attempt" -lt 50 ] || exit 0
  sleep 0.1 || exit 0
done
owned=
while IFS= read -r cgroup; do
  case "$cgroup" in
    0::*"/$2"|*:name=systemd:*"/$2") owned=1 ;;
  esac
done < /proc/self/cgroup
[ "$owned" = 1 ] || exit 0
exec systemctl --user --no-block stop "$2"
`

type ScopeDeathWatchOptions = {
  freshScope: boolean
  launchNonce?: string
  log: (event: string, details?: Record<string, unknown>) => void
  platform?: NodeJS.Platform
  detectScope?: typeof detectOwnCgroupScopeUnit
  spawn?: (spec: ProcessSpec) => SpawnedProcess
}

export function startDaemonScopeDeathWatch(options: ScopeDeathWatchOptions): SpawnedProcess | null {
  const { freshScope, launchNonce, log } = options
  if ((options.platform ?? process.platform) !== 'linux' || !freshScope || !launchNonce) {
    return null
  }
  const unit = daemonScopeUnitName(launchNonce)
  // Migrated legacy scopes may also hold the GUI, so a name alone never authorizes cleanup.
  if ((options.detectScope ?? detectOwnCgroupScopeUnit)() !== unit) {
    return null
  }
  const env = { ...process.env }
  delete env.DBUS_SESSION_BUS_ADDRESS
  try {
    const child = (options.spawn ?? spawnProcess)({
      program: '/bin/sh',
      args: ['-c', SCOPE_DEATH_WATCH_SCRIPT, 'orca-daemon-scope-watch', String(process.pid), unit],
      env,
      detached: true,
      stdio: ['pipe', 'ignore', 'ignore']
    })
    child.on('error', (error) => log('scope-death-watch-error', { message: error.message }))
    child.stdin?.on('error', (error: Error) =>
      log('scope-death-watch-pipe-error', { message: error.message })
    )
    child.on('exit', (code, signal) => {
      child.stdin?.destroy()
      log('scope-death-watch-exit', { code, signal })
    })
    child.unref()
    return child
  } catch (error) {
    log('scope-death-watch-error', { message: String(error) })
    return null
  }
}
