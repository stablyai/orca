import { dirname } from 'node:path'
import type { DaemonFileLog } from '../observability/daemon-file-log'
import {
  providerRelayCapabilities,
  type ProviderRelayCapability
} from '../protocol/daemon-provider-relay-protocol'
import { ProviderRelayHost } from './provider-relay-host'
import type { DaemonToolRelayFront } from '../tool-relay-front/daemon-tool-relay-front'

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

/** `toolRelayFront` is the front itself, which the connections layer splices into. */
type DaemonProviderRelayIdentity = Partial<
  Record<Exclude<ProviderRelayCapability, 'toolRelayFront'>, true>
> & { toolRelayFront?: DaemonToolRelayFront }

/** The daemon's chat-agent host and the hello capability that tells an app it may use it. */
export function createDaemonProviderRelays(options: DaemonProviderRelayOptions): {
  relays: ProviderRelayHost
  identity: DaemonProviderRelayIdentity
} {
  const advertised = providerRelayCapabilities(options.protocolVersion)
  const relays = new ProviderRelayHost({
    runtimeDir: dirname(options.tokenPath),
    appVersion: options.appVersion ?? null,
    entryPath: options.entryPath ?? null,
    daemonInstance: options.daemonInstance,
    toolRelayFront: advertised.includes('toolRelayFront'),
    acceptsWork: options.acceptsWork,
    onLiveCountChanged: options.onLiveCountChanged,
    log: (event, details) => options.log.log(event, details)
  })
  const identity: DaemonProviderRelayIdentity = {}
  for (const capability of relays.supported ? advertised : []) {
    if (capability !== 'toolRelayFront') {
      identity[capability] = true
    }
  }
  if (relays.toolRelayFront) {
    identity.toolRelayFront = relays.toolRelayFront
  }
  return { relays, identity }
}
