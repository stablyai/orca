import type { DaemonClient } from '../daemon/transport/client/daemon-client'

/** Desktop composition installs this on macOS and Linux; anywhere else chats launch as before. */
export type ProviderRelayRoute = {
  /** The daemon this app launched or adopted for its own bundle; the only one new chats go to. */
  current: () => Promise<DaemonClient | null>
  /** Every daemon generation, so relays kept by an older one are found at launch too. */
  all: () => Promise<DaemonClient[]>
  appVersion: string
  /** The user's native-chat idle stop, read at each attach and detach. */
  idleStopMs: () => number | null
}

let route: ProviderRelayRoute | null = null

export function installProviderRelayRoute(installed: ProviderRelayRoute | null): void {
  route = installed
}

export function providerRelayRoute(): ProviderRelayRoute | null {
  return route
}
