import { EventEmitter } from 'node:events'
import { win32 } from 'node:path'
import type { ProcessSpec } from './process-spec'
import { spawnProcess } from './run-process'
import { resolveSpawn } from './spawn-resolution'
import { hasSpawnObserver, notifySpawnObserver } from './spawn-observer'

/** Main installs the native spawner; daemon, relay, and CLI fall back to libuv. Empty cwd: ours. */
export type IsolatedSpawner = (
  file: string,
  commandLine: string,
  cwd: string,
  environmentBlock: string,
  onExit: (code: number) => void
) => { pid: number; exitWatchError: number | null; breakawayDenied?: boolean }

export type DetachedChild = EventEmitter & {
  readonly pid?: number
  unref(): void
  kill(signal?: NodeJS.Signals): boolean
}

export type DetachedSpec = Omit<ProcessSpec, 'stdio' | 'detached' | 'windowsVerbatimArguments'>

let isolatedSpawner: IsolatedSpawner | null = null

export function setIsolatedSpawner(next: IsolatedSpawner | null): void {
  isolatedSpawner = next
}

// libuv's quote_cmd_arg, so a holder's command line matches what uv_spawn produced before.
export function quoteWindowsArgumentLikeLibuv(value: string): string {
  if (value === '') {
    return '""'
  }
  if (!/[ \t"]/.test(value)) {
    return value
  }
  if (!/["\\]/.test(value)) {
    return `"${value}"`
  }
  let quoted = '"'
  let backslashes = 0
  for (const char of value) {
    if (char === '\\') {
      backslashes += 1
      continue
    }
    quoted +=
      char === '"' ? `${'\\'.repeat(backslashes * 2 + 1)}"` : `${'\\'.repeat(backslashes)}${char}`
    backslashes = 0
  }
  return `${quoted}${'\\'.repeat(backslashes * 2)}"`
}

// Variables libuv copies from the parent when the given env lacks them; Windows breaks without some.
const REQUIRED_WINDOWS_ENV = [
  'HOMEDRIVE',
  'HOMEPATH',
  'LOGONSERVER',
  'PATH',
  'SYSTEMDRIVE',
  'SYSTEMROOT',
  'TEMP',
  'USERDOMAIN',
  'USERNAME',
  'USERPROFILE',
  'WINDIR'
]

/** libuv's make_program_env: required variables filled in, sorted case-insensitively, `\0\0`-ended. */
export function buildWindowsEnvironmentBlock(
  env: NodeJS.ProcessEnv,
  parentEnv: NodeJS.ProcessEnv = process.env
): string {
  const entries = new Map<string, string>()
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && !entries.has(key.toUpperCase())) {
      entries.set(key.toUpperCase(), `${key}=${value}`)
    }
  }
  for (const required of REQUIRED_WINDOWS_ENV) {
    if (entries.has(required)) {
      continue
    }
    const inherited = Object.entries(parentEnv).find(([key]) => key.toUpperCase() === required)
    if (inherited?.[1] !== undefined) {
      entries.set(required, `${inherited[0]}=${inherited[1]}`)
    }
  }
  const sorted = [...entries.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `${sorted.map(([, entry]) => `${entry}\0`).join('')}\0`
}

/**
 * Detached, stdio-ignoring spawn whose child inherits none of Orca's handles on Windows.
 * Falls back to spawnProcess off Windows, without an installed spawner, or for programs that need
 * cmd.exe or a relative-path lookup.
 */
export function spawnDetachedWithoutInheritance(spec: DetachedSpec): DetachedChild {
  const fallback = (): DetachedChild => spawnProcess({ ...spec, detached: true, stdio: 'ignore' })
  const spawner = isolatedSpawner
  if (process.platform !== 'win32' || !spawner) {
    return fallback()
  }
  const resolved = resolveSpawn({ ...spec, detached: true, stdio: 'ignore' }, 'win32')
  if (resolved.options.windowsVerbatimArguments || !win32.isAbsolute(resolved.file)) {
    return fallback()
  }
  const child = new EventEmitter()
  const commandLine = [resolved.file, ...resolved.args].map(quoteWindowsArgumentLikeLibuv).join(' ')
  const startedAt = hasSpawnObserver() ? performance.now() : null
  let pid: number | undefined
  let exited = false
  // No exit watch means no exit event: the pid may be reused, so kill() must not target it.
  let untracked = false
  let killedWith: NodeJS.Signals | null = null
  // Like libuv: an exit after our own kill() reports (null, signal); any other exit, its code.
  const onExit = (code: number): void => {
    exited = true
    child.emit('exit', killedWith ? null : code, killedWith)
    child.emit('close', killedWith ? null : code, killedWith)
  }
  const kill = (signal: NodeJS.Signals = 'SIGTERM'): boolean => {
    if (pid === undefined || exited || untracked) {
      return false
    }
    try {
      process.kill(pid, signal)
    } catch {
      return false
    }
    killedWith = signal
    return true
  }
  try {
    const spawned = spawner(
      resolved.file,
      commandLine,
      spec.cwd ?? '',
      buildWindowsEnvironmentBlock(resolved.options.env ?? process.env),
      onExit
    )
    pid = spawned.pid
    if (startedAt !== null) {
      notifySpawnObserver(resolved.file, resolved.args, performance.now() - startedAt)
    }
    if (spawned.breakawayDenied) {
      // The child stays in a job this process is in, and dies if that job is closed with it.
      console.warn(`[process-host] pid ${pid} could not break away from this process's job`)
    }
    if (spawned.exitWatchError !== null) {
      untracked = true
      console.warn(
        `[process-host] pid ${pid} is untracked: its exit is unobservable (Win32 error ${spawned.exitWatchError}), so kill() will refuse it`
      )
    }
    process.nextTick(() => child.emit('spawn'))
  } catch (error) {
    process.nextTick(() => child.emit('error', error))
  }
  // The native exit watch never holds the event loop, so unref has nothing to release.
  return Object.assign(child, { pid, unref: () => {}, kill })
}
