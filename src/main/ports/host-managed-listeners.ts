import { readFileSync } from 'node:fs'
import type { RawListeningPort } from './local-workspace-port-scan-state'

/** Colon-separated install roots whose binaries are the host's own services (e.g. a sandbox image's tools). */
export const HOST_MANAGED_LISTENER_PATHS_ENV = 'ORCA_HOST_MANAGED_LISTENER_PATHS'
/** Comma-separated ports the host's platform listens on from a process this user cannot see (no pid). */
export const HOST_MANAGED_UNOWNED_PORTS_ENV = 'ORCA_HOST_MANAGED_UNOWNED_PORTS'

export type HostManagedListenerConfig = {
  roots: readonly string[]
  unownedPorts: ReadonlySet<number>
}

export function hostManagedListenerConfig(
  env: Record<string, string | undefined> = process.env
): HostManagedListenerConfig {
  const roots = (env[HOST_MANAGED_LISTENER_PATHS_ENV] ?? '')
    .split(':')
    .map((root) => root.trim().replace(/\/+$/, ''))
    .filter((root) => root.startsWith('/') && root.length > 1)
  const unownedPorts = new Set(
    (env[HOST_MANAGED_UNOWNED_PORTS_ENV] ?? '')
      .split(',')
      .map((port) => Number(port.trim()))
      .filter((port) => Number.isInteger(port) && port > 0 && port < 65536)
  )
  return { roots, unownedPorts }
}

/**
 * Listeners the host runs itself: this server process, a program started from a managed root
 * (checked on argv[0] and argv[1], so `python3 /root/bin/tool` counts too) or its descendant, or a
 * declared platform port whose owner is invisible. A pid-less listener on any other port (a root-run postgres or
 * Docker-published port) is still the user's.
 */
export function isHostManagedListener(
  port: Pick<RawListeningPort, 'pid' | 'commandLine' | 'port'>,
  config: HostManagedListenerConfig,
  serverPid: number = process.pid,
  readParent: (pid: number) => ParentProcess | undefined = readLinuxParentProcess
): boolean {
  if (port.pid === undefined) {
    return config.unownedPorts.has(port.port)
  }
  if (port.pid === serverPid) {
    return true
  }
  if (config.roots.length === 0) {
    return false
  }
  if (startedFromRoot(port.commandLine, config.roots)) {
    return true
  }
  // A managed tool's descendant (agent-browser's Chrome DevTools port). The walk stops at the server
  // (it spawns the user's terminals) and at a shell (a user session, e.g. over the managed sshd).
  let pid = port.pid
  for (let depth = 0; depth < MAX_ANCESTRY_DEPTH; depth++) {
    const parent = readParent(pid)
    if (!parent || parent.pid === serverPid || isShell(parent.commandLine)) {
      return false
    }
    if (startedFromRoot(parent.commandLine, config.roots)) {
      return true
    }
    pid = parent.pid
  }
  return false
}

const MAX_ANCESTRY_DEPTH = 8
const SHELLS = new Set(['sh', 'bash', 'dash', 'zsh', 'fish', 'ksh', 'tcsh', 'csh', 'nu', 'pwsh'])

function isShell(commandLine: string): boolean {
  const argv0 = commandLine.trim().split(/\s+/)[0] ?? ''
  return SHELLS.has(argv0.replace(/^-/, '').split('/').pop() ?? '')
}

export type ParentProcess = { pid: number; commandLine: string }

function startedFromRoot(commandLine: string | undefined, roots: readonly string[]): boolean {
  return (commandLine ?? '')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .some((token) => roots.some((root) => token === root || token.startsWith(`${root}/`)))
}

function readLinuxParentProcess(pid: number): ParentProcess | undefined {
  if (process.platform !== 'linux') {
    return undefined
  }
  try {
    // /proc/<pid>/stat: "pid (comm) state ppid ..."; comm may contain spaces or parens.
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1])
    if (!Number.isInteger(ppid) || ppid <= 1) {
      return undefined
    }
    const commandLine = readFileSync(`/proc/${ppid}/cmdline`, 'utf8').split('\0').join(' ').trim()
    return { pid: ppid, commandLine }
  } catch {
    return undefined
  }
}
