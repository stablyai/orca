import type { RawListeningPort } from './local-workspace-port-scan-state'

/** Colon-separated install roots whose binaries are the host's own services (e.g. a sandbox image's tools). */
export const HOST_MANAGED_LISTENER_PATHS_ENV = 'ORCA_HOST_MANAGED_LISTENER_PATHS'

export function hostManagedListenerRoots(
  env: Record<string, string | undefined> = process.env
): string[] {
  return (env[HOST_MANAGED_LISTENER_PATHS_ENV] ?? '')
    .split(':')
    .map((root) => root.trim().replace(/\/+$/, ''))
    .filter((root) => root.startsWith('/') && root.length > 1)
}

/**
 * Listeners the host runs itself: this server process, or a program started from a managed root
 * (checked on argv[0] and argv[1], so `python3 /root/bin/tool` counts too).
 */
export function isHostManagedListener(
  port: Pick<RawListeningPort, 'pid' | 'commandLine'>,
  roots: readonly string[],
  serverPid: number = process.pid
): boolean {
  if (port.pid !== undefined && port.pid === serverPid) {
    return true
  }
  if (roots.length === 0 || !port.commandLine) {
    return false
  }
  return port.commandLine
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .some((token) => roots.some((root) => token === root || token.startsWith(`${root}/`)))
}
