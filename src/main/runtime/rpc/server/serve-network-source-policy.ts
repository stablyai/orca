// Which source addresses `orca serve` accepts, decided once at startup.
import { isPairingWildcardHostname } from '../../../../shared/network/pairing-url'
import { isIP } from 'node:net'
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os'
import { classifyRemotePairingHostname } from '../../../../shared/remote-runtime/pairing/remote-pairing-address'
import { resolveAdvertisedPairingHostname } from './pairing/network/pairing-endpoint'
import { classifyNetworkSource } from '../network-source-class'
import { PublicSourceRefusal, type WebSocketSourceGuard } from '../ws-network-source-guard'
import type { DeviceEntry } from './pairing/device-entry'
import {
  ensureNetworkSourceGuardSince,
  type NetworkSourcePolicyRecord
} from './network-source-policy-store'

export type ServeNetworkSourceOptions = {
  allowPublic: boolean
  // Refuse public sources now, overriding grandfathering, remembered sightings and the pairing address.
  refusePublic?: boolean
  pairingAddress: string | null
}

export type ServeNetworkSourcePolicy =
  | { kind: 'local-only'; forced?: true }
  | { kind: 'public-allowed'; reason: 'flag' | 'paired-public' | 'pairing-address' | 'bind' }
  | { kind: 'grandfathered'; devices: number }

export function resolveServeNetworkSourcePolicy(args: {
  options: ServeNetworkSourceOptions
  record: NetworkSourcePolicyRecord & { guardSince: number }
  devices: readonly DeviceEntry[]
  bindHost?: string
}): ServeNetworkSourcePolicy {
  if (args.options.allowPublic) {
    return { kind: 'public-allowed', reason: 'flag' }
  }
  if (args.options.refusePublic) {
    return { kind: 'local-only', forced: true }
  }
  if (args.record.allowPublicSources) {
    return { kind: 'public-allowed', reason: 'paired-public' }
  }
  if (advertisesNonLocalAddress(args.options.pairingAddress)) {
    return { kind: 'public-allowed', reason: 'pairing-address' }
  }
  // Wildcards classify as public too, but only a literal public bind states intent.
  if (
    args.bindHost !== undefined &&
    !isPairingWildcardHostname(args.bindHost) &&
    classifyNetworkSource(args.bindHost) === 'public'
  ) {
    return { kind: 'public-allowed', reason: 'bind' }
  }
  // Any row from before the guard (pending offers included) may belong to a client that reaches us from a public address.
  const predating = args.devices.filter(
    (device) => device.ephemeral !== true && device.pairedAt <= args.record.guardSince
  ).length
  return predating > 0 ? { kind: 'grandfathered', devices: predating } : { kind: 'local-only' }
}

/** Hostnames resolve elsewhere, so only a loopback, LAN or Tailscale IP literal counts as local. */
function advertisesNonLocalAddress(pairingAddress: string | null): boolean {
  const hostname = resolveAdvertisedPairingHostname(pairingAddress)
  if (hostname === null) {
    return false
  }
  const kind = classifyRemotePairingHostname(hostname)
  return kind === 'public' || kind === 'custom'
}

export function describeServeNetworkSourcePolicy(
  policy: ServeNetworkSourcePolicy,
  pairingAddress: string | null,
  bindHost?: string
): string {
  switch (policy.kind) {
    case 'local-only':
      return policy.forced
        ? 'Accepting connections from localhost, LAN and Tailscale addresses; public addresses are refused (--refuse-public).'
        : 'Accepting connections from localhost, LAN and Tailscale addresses; public addresses are refused (restart with --allow-public to accept them).'
    case 'grandfathered':
      return `Accepting connections from any address: ${policy.devices} paired device(s) predate the public-address check and may rely on one. Once they are removed, public addresses are refused unless a paired device has connected from one or --allow-public is set; --refuse-public refuses them now.`
    case 'public-allowed':
      switch (policy.reason) {
        case 'flag':
          return 'Accepting connections from any address (--allow-public).'
        case 'paired-public':
          return 'Accepting connections from any address: a paired device has connected from a public address.'
        case 'pairing-address':
          return `Accepting connections from any address: --pairing-address ${pairingAddress ?? ''} is not a localhost, LAN or Tailscale IP address.`
        case 'bind':
          return `Accepting connections from any address: --bind ${bindHost ?? ''} is a public IP address.`
      }
  }
}

/** A public IPv4 on an interface (a typical VPS) is dialable directly; global IPv6 on home hosts is usually firewalled, so it is not named. */
export function publicSourceRefusalNotice(
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces()
): string | null {
  const address = Object.values(interfaces)
    .flatMap((entries) => entries ?? [])
    .find(
      (entry) =>
        !entry.internal &&
        isIP(entry.address) === 4 &&
        classifyNetworkSource(entry.address) === 'public'
    )?.address
  return address
    ? `This host has public address ${address}, but clients connecting from public addresses are refused. Restart orca serve with --allow-public to accept them.`
    : null
}

/** Null when nothing is refused: not serving, loopback-only, or public addresses allowed. */
export function createServeNetworkSourceGuard(args: {
  options: ServeNetworkSourceOptions | null
  bindHost: string
  userDataPath: string
  devices: readonly DeviceEntry[]
  now?: number
  log?: (message: string) => void
}): WebSocketSourceGuard | null {
  if (!args.options || classifyNetworkSource(args.bindHost) === 'loopback') {
    return null
  }
  const policy = resolveServeNetworkSourcePolicy({
    options: args.options,
    record: ensureNetworkSourceGuardSince(args.userDataPath, args.now ?? Date.now()),
    devices: args.devices,
    bindHost: args.bindHost
  })
  const log = args.log ?? console.log
  log(
    `[runtime] ${describeServeNetworkSourcePolicy(policy, args.options.pairingAddress, args.bindHost)}`
  )
  return policy.kind === 'local-only' ? new PublicSourceRefusal() : null
}
