import type { WslHostConnector } from './wsl-host-service'

/**
 * Whether a focused host answers. Without a bridge in this process nothing answers yet, and focus
 * connects whatever the running list says, so the WSL round trip would only delay the connect.
 * Polls never use this: they must read the running list so they never boot a stopped distro (E9).
 */
export function focusReachability(
  connector: Pick<WslHostConnector, 'get' | 'reachability'>,
  record: { distro: string; environmentId: string }
): ReturnType<WslHostConnector['reachability']> {
  return connector.get(record.distro)
    ? connector.reachability(record.distro, record.environmentId)
    : Promise.resolve('unreachable')
}
