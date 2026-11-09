import { z } from 'zod'
import '../../../../src/shared/remote-runtime/pairing/mobile-relay-pairing-offer'
import {
  MobileRelayEndpointSchema,
  type MobileRelayEndpoint
} from '../../../../src/shared/remote-runtime/relay/mobile-relay-credential-contract'
import { NODE_PLATFORM_NAMES } from '../connection/mobile-runtime-host-platform'
import { salvagedOptional } from '../../../../src/shared/zod-salvage'
import type { HostMachine } from '../../../../src/shared/host-machine-line'
import { HostMachineSchema } from './host-status-reply-schema'

export type HostProfile = {
  id: string
  // Resolved display name; an OS-only desktop report preserves the last adopted name.
  name: string
  // This phone’s rename overrides the desktop’s machine name.
  personalName?: string
  // Last desktop-reported name, retained offline and across restarts.
  lastKnownMachineName?: string
  lastKnownHostPlatform?: NodeJS.Platform
  lastKnownHostMachine?: HostMachine
  endpoint: string
  deviceToken: string
  publicKeyB64: string
  lastConnected: number
  /** Relay routing, joined from the overlay; only `setRelayRouting` and pairing write it. */
  relay?: MobileRelayEndpoint
}

export type HostCredentialStatus = 'ready' | 'temporarily-unavailable' | 'missing'

export type HostCatalogEntry = Omit<HostProfile, 'deviceToken'> & {
  credentialStatus: HostCredentialStatus
  profile: HostProfile | null
}

// Salvage unknown/empty platform values independently so persisting them cannot drop the paired host.
// Keep outer optional() so the inferred key remains optional.
const hostNameIdentityFields = {
  personalName: salvagedOptional('personalName', z.string().min(1)).optional(),
  lastKnownMachineName: salvagedOptional('lastKnownMachineName', z.string().min(1)).optional(),
  lastKnownHostPlatform: salvagedOptional(
    'lastKnownHostPlatform',
    z.enum(NODE_PLATFORM_NAMES)
  ).optional(),
  lastKnownHostMachine: salvagedOptional('lastKnownHostMachine', HostMachineSchema).optional()
}

export const HostProfileSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  ...hostNameIdentityFields,
  endpoint: z.string().min(1),
  deviceToken: z.string().min(1),
  publicKeyB64: z.string().min(1),
  lastConnected: z.number().finite(),
  relay: MobileRelayEndpointSchema.optional()
})

// Never persist deviceToken in AsyncStorage; join it from Keychain when loading the host.
export const StoredHostProfileSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  ...hostNameIdentityFields,
  endpoint: z.string().min(1),
  publicKeyB64: z.string().min(1),
  lastConnected: z.number().finite()
})

export type StoredHostProfile = z.infer<typeof StoredHostProfileSchema>
