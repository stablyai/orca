import type { PaneSpawnReservationPathFlavor } from '../../shared/stable-pane-id'

export function resolvePaneSpawnReservationPathFlavor(args: {
  connectionId?: string | null
  executionRuntime: string
  remotePathFlavor?: PaneSpawnReservationPathFlavor | null
  localPlatform?: NodeJS.Platform
}): PaneSpawnReservationPathFlavor {
  if (args.connectionId) {
    return args.remotePathFlavor ?? 'unknown'
  }
  if (args.executionRuntime.startsWith('wsl:')) {
    return 'windows'
  }
  return (args.localPlatform ?? process.platform) === 'win32' ? 'windows' : 'posix'
}
