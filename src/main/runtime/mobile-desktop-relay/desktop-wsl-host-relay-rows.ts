import type {
  MobileDesktopRelayHostListing,
  MobileDesktopRelayHosts
} from './mobile-desktop-relay-hosts'
import type { ServerWorktreeRows } from './mobile-relay-host-catalog'

/** This desktop's own WSL distro: phones reach it through the relay, the desktop lists it itself. */
export function isDesktopWslHostListing(
  environment: Pick<MobileDesktopRelayHostListing, 'orcadDeployment'>
): boolean {
  return environment.orcadDeployment?.kind === 'wsl'
}

/** The relay's servers without this desktop's WSL hosts, for the desktop sidebar's paired-server rows. */
export function withoutDesktopWslHosts(hosts: MobileDesktopRelayHosts): MobileDesktopRelayHosts {
  return {
    ...hosts,
    list: () => {
      const listing = hosts.list()
      const environments = listing.environments.filter(
        (environment) => !isDesktopWslHostListing(environment)
      )
      const kept = new Set(environments.map((environment) => environment.id))
      return {
        ...listing,
        environments,
        statusByEnvironmentId: new Map(
          [...listing.statusByEnvironmentId].filter(([environmentId]) => kept.has(environmentId))
        )
      }
    }
  }
}

/** A WSL host's rows for a phone come from an on-demand fetch; every other server's from the sidebar's set. */
export function serverRowsWithDesktopWslHostsOnDemand(
  hosts: MobileDesktopRelayHosts,
  sidebarRows: ServerWorktreeRows,
  onDemand: ServerWorktreeRows
): ServerWorktreeRows {
  const source = (environmentId: string): ServerWorktreeRows =>
    hosts
      .list()
      .environments.some(
        (environment) => environment.id === environmentId && isDesktopWslHostListing(environment)
      )
      ? onDemand
      : sidebarRows
  return {
    sync: () => {
      sidebarRows.sync()
      onDemand.sync()
    },
    refresh: (environmentId) => source(environmentId).refresh(environmentId),
    rows: (environmentId, fence) => source(environmentId).rows(environmentId, fence)
  }
}
