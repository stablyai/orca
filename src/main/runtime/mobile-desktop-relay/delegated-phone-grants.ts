import { z } from 'zod'
import {
  DELEGATED_MOBILE_DEVICE_SYNC_METHOD,
  DELEGATED_MOBILE_DEVICE_SYNC_MAX_PHONES,
  DELEGATED_MOBILE_DEVICES_RUNTIME_CAPABILITY,
  type DelegatedMobileDeviceSyncParams
} from '../../../shared/delegated-mobile-device-contract'
import { RemoteRuntimeClientError } from '../../../shared/remote-runtime-client-error'
import type { MobileDesktopRelayHost, MobileDesktopRelayHosts } from './mobile-desktop-relay-hosts'

const SyncResultSchema = z.object({
  devices: z.array(z.object({ phoneKey: z.string(), deviceId: z.string(), token: z.string() }))
})
const StatusCapabilitiesSchema = z.object({ capabilities: z.array(z.string()).optional() })

export type DelegatedPhoneGrant = { deviceId: string; token: string }

/** One sync's outcome for a host; held in memory only, so the next sync is the only recovery. */
export type DelegatedPhoneGrants =
  | { kind: 'update-needed'; fence: string }
  | {
      kind: 'ready'
      fence: string
      grants: ReadonlyMap<string, DelegatedPhoneGrant>
      // Every phone this sync asked for; one asked for but not granted waits for the next sync.
      asked: ReadonlySet<string>
      // Phones whose host token was refused (revoked on the host); not retried until the next sync.
      refused: Set<string>
    }

export async function syncDelegatedPhoneGrants(
  hosts: MobileDesktopRelayHosts,
  host: MobileDesktopRelayHost,
  phones: DelegatedMobileDeviceSyncParams['phones']
): Promise<DelegatedPhoneGrants> {
  const status = await hosts.call(host, 'status.get', undefined)
  if (!status.ok) {
    throw new RemoteRuntimeClientError('remote_runtime_unavailable', status.error.message)
  }
  const capabilities = StatusCapabilitiesSchema.safeParse(status.result).data?.capabilities ?? []
  if (!capabilities.includes(DELEGATED_MOBILE_DEVICES_RUNTIME_CAPABILITY)) {
    return { kind: 'update-needed', fence: host.fence }
  }
  const response = await hosts.call(host, DELEGATED_MOBILE_DEVICE_SYNC_METHOD, {
    phones: phones.slice(0, DELEGATED_MOBILE_DEVICE_SYNC_MAX_PHONES)
  })
  if (!response.ok) {
    throw new RemoteRuntimeClientError('remote_runtime_unavailable', response.error.message)
  }
  const result = SyncResultSchema.safeParse(response.result)
  if (!result.success) {
    throw new RemoteRuntimeClientError(
      'invalid_runtime_response',
      'Remote Orca runtime returned an invalid delegated device sync.'
    )
  }
  return {
    kind: 'ready',
    fence: host.fence,
    grants: new Map(
      result.data.devices.map((device) => [
        device.phoneKey,
        { deviceId: device.deviceId, token: device.token }
      ])
    ),
    asked: new Set(phones.map((phone) => phone.phoneKey)),
    refused: new Set()
  }
}
