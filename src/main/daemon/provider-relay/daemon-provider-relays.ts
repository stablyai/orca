import { dirname } from 'node:path'
import type { DaemonFileLog } from '../observability/daemon-file-log'
import { PROVIDER_RELAY_PROTOCOL_VERSION } from '../protocol/daemon-provider-relay-protocol'
import { ProviderRelayHost } from './provider-relay-host'

type DaemonProviderRelayOptions = {
  tokenPath: string
  appVersion?: string
  entryPath?: string
  protocolVersion: number
  acceptsWork: () => boolean
  onLiveCountChanged: () => void
  log: DaemonFileLog
}

/** The daemon's chat-agent host and the hello capability that tells an app it may use it. */
export function createDaemonProviderRelays(options: DaemonProviderRelayOptions): {
  relays: ProviderRelayHost
  identity: { providerRelay?: true }
} {
  const relays = new ProviderRelayHost({
    runtimeDir: dirname(options.tokenPath),
    appVersion: options.appVersion ?? null,
    entryPath: options.entryPath ?? null,
    acceptsWork: options.acceptsWork,
    onLiveCountChanged: options.onLiveCountChanged,
    log: (event, details) => options.log.log(event, details)
  })
  const advertised = relays.supported && options.protocolVersion >= PROVIDER_RELAY_PROTOCOL_VERSION
  return { relays, identity: advertised ? { providerRelay: true } : {} }
}
