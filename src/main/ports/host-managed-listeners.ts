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
 * (checked on argv[0] and argv[1], so `python3 /root/bin/tool` counts too), or a declared platform
 * port whose owner is invisible. A pid-less listener on any other port (a root-run postgres or
 * Docker-published port) is still the user's.
 */
export function isHostManagedListener(
  port: Pick<RawListeningPort, 'pid' | 'commandLine' | 'port'>,
  config: HostManagedListenerConfig,
  serverPid: number = process.pid
): boolean {
  if (port.pid === undefined) {
    return config.unownedPorts.has(port.port)
  }
  if (port.pid === serverPid) {
    return true
  }
  if (config.roots.length === 0 || !port.commandLine) {
    return false
  }
  return port.commandLine
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .some((token) => config.roots.some((root) => token === root || token.startsWith(`${root}/`)))
}
