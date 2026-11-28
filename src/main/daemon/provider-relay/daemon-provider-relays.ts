import { dirname } from 'node:path'
import type { DaemonFileLog } from '../observability/daemon-file-log'
import {
  providerRelayCapabilities,
  type ProviderRelayCapability
} from '../protocol/daemon-provider-relay-protocol'
import { ProviderRelayHost } from './provider-relay-host'

type DaemonProviderRelayOptions = {
  tokenPath: string
  appVersion?: string
  entryPath?: string
  protocolVersion: number
  /** This start's hello `launchNonce`; null only for daemons without an identity, which never relay. */
  daemonInstance: string | null
  acceptsWork: () => boolean
  onLiveCountChanged: () => void
  log: DaemonFileLog
}

/** The daemon's chat-agent host and the hello capability that tells an app it may use it. */
export function createDaemonProviderRelays(options: DaemonProviderRelayOptions): {
  relays: ProviderRelayHost
  identity: Partial<Record<ProviderRelayCapability, true>>
} {
  const relays = new ProviderRelayHost({
    runtimeDir: dirname(options.tokenPath),
    appVersion: options.appVersion ?? null,
    entryPath: options.entryPath ?? null,
    daemonInstance: options.daemonInstance,
    acceptsWork: options.acceptsWork,
    onLiveCountChanged: options.onLiveCountChanged,
    log: (event, details) => options.log.log(event, details)
  })
  const identity: Partial<Record<ProviderRelayCapability, true>> = {}
  const advertised = relays.supported ? providerRelayCapabilities(options.protocolVersion) : []
  for (const capability of advertised) {
    identity[capability] = true
  }
  return { relays, identity }
}
