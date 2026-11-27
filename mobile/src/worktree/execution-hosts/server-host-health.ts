// A relayed server's health as its workspace pill says it; no transport, so list builders can read it.
import type { ExecutionHostId } from '../../../../src/shared/execution-host/execution-host'
import type { ExecutionHostHealth } from '../../../../src/shared/execution-host/execution-host-health'
import type { MobileRelayHost } from '../../../../src/shared/remote-runtime/relay/mobile-relay-hosts-contract'

export function serverHostHealth(host: MobileRelayHost): ExecutionHostHealth {
  return host.relay === 'update-needed' ? 'blocked' : host.health
}

/** The desktop's own WSL host that only the desktop can bring up: stopped, or not ready there. */
export type ServerHostDesktopReach = 'stopped' | 'unavailable'

export function serverHostDesktopReach(host: MobileRelayHost): ServerHostDesktopReach | undefined {
  if (host.stoppedOnDesktop) {
    return 'stopped'
  }
  return host.unavailableOnDesktop ? 'unavailable' : undefined
}

// Why: a phone never starts or connects the desktop's own WSL host, so the badge says where to.
export function serverHostHealthLabel(host: MobileRelayHost): string | undefined {
  const reach = serverHostDesktopReach(host)
  if (reach === undefined) {
    return undefined
  }
  return reach === 'stopped' ? 'Start on computer' : 'Open on computer'
}

export function serverHostHealthLabels(
  hosts: readonly MobileRelayHost[]
): ReadonlyMap<ExecutionHostId, string> {
  return new Map(
    hosts.flatMap((host) => {
      const label = serverHostHealthLabel(host)
      return label ? [[host.hostId, label] as const] : []
    })
  )
}
