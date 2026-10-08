import type { RelayDeviceBinding, RelayRevokeOutboxItem } from '../relay/relay-revoke-outbox'
import type {
  DelegatedPhone,
  DelegatedMobileDeviceSyncResult
} from '../../../shared/delegated-mobile-device-contract'
import { RuntimeRpcRequestAdmission } from './runtime-rpc-request-admission'

// Why: below dispatch so a caller-bound RPC context can revoke and mint mobile devices.
export class RuntimeRpcMobileDevices extends RuntimeRpcRequestAdmission {
  private onPushUnregisterQueued?: () => void

  async revokeMobileDevice(deviceId: string): Promise<boolean> {
    const revoked = this.revokeMobileDeviceNow(deviceId)
    if (revoked) {
      this.mobileDesktopRelay?.phonesChanged()
    }
    return revoked
  }

  private revokeMobileDeviceNow(deviceId: string): boolean {
    const device = this.deviceRegistry?.getDevice(deviceId)
    if (device?.scope !== 'mobile') {
      return false
    }
    if (device.relayBinding) {
      if (!this.queueRelayDeviceRevoke(device.relayBinding)) {
        return false
      }
    }
    // Why: unpairing must delete the phone's push token at the gateway too, and the
    // registration id is only readable while the device row still exists.
    this.queuePushUnregister(deviceId, device.pushRegistration?.registrationId)
    if (!this.deviceRegistry?.removeDevice(deviceId)) {
      return false
    }
    this.mobileRelayPairingProvider?.onDemandStateChanged?.()
    this.runtime.forgetClientNavigationState(deviceId)
    this.mobileSocketWiring?.terminateDeviceConnections(device.token)
    return true
  }

  revokeRuntimeAccess(deviceId: string): boolean {
    const device = this.deviceRegistry?.getDevice(deviceId)
    if (device?.scope !== 'runtime') {
      return false
    }
    for (const child of this.deviceRegistry?.listDelegatedMobileDevices(deviceId) ?? []) {
      // Why: keep the parent until every child's cleanup is saved, so a retry can still find them.
      if (!this.revokeMobileDeviceNow(child.deviceId)) {
        return false
      }
    }
    if (!this.deviceRegistry?.removeDevice(deviceId)) {
      return false
    }
    this.runtime.forgetClientNavigationState(deviceId)
    this.mobileSocketWiring?.terminateDeviceConnections(device.token)
    return true
  }

  /** Make the runtime device `parentDeviceId`'s phones exactly `phones`; dropped ones are fully revoked. */
  protected syncDelegatedMobileDevices(
    parentDeviceId: string,
    phones: readonly DelegatedPhone[]
  ): DelegatedMobileDeviceSyncResult {
    const registry = this.deviceRegistry
    const parent = registry?.getDevice(parentDeviceId)
    if (!registry || parent?.scope !== 'runtime') {
      throw new Error('delegated_device_parent_unavailable')
    }
    const wanted = new Set(phones.map((phone) => phone.phoneKey))
    for (const child of registry.listDelegatedMobileDevices(parentDeviceId)) {
      if (
        (!child.phoneKey || !wanted.has(child.phoneKey)) &&
        !this.revokeMobileDeviceNow(child.deviceId)
      ) {
        throw new Error('delegated_device_revoke_failed')
      }
    }
    return {
      devices: registry.upsertDelegatedMobileDevices(parent, phones).map((device) => ({
        phoneKey: device.phoneKey,
        deviceId: device.deviceId,
        token: device.token
      }))
    }
  }

  /** Best-effort: a failed enqueue must never block the revoke the user asked for. */
  protected queuePushUnregister(deviceId: string, registrationId: string | undefined): void {
    if (!registrationId) {
      return
    }
    try {
      this.pushUnregisterOutbox.enqueue({ registrationId, deviceId })
      this.onPushUnregisterQueued?.()
    } catch (error) {
      console.error('[runtime] Failed to persist a push token cleanup:', error)
    }
  }

  setOnPushUnregisterQueued(callback: (() => void) | null): void {
    this.onPushUnregisterQueued = callback ?? undefined
  }

  protected queueRelayDeviceRevoke(binding: RelayDeviceBinding): boolean {
    let item: RelayRevokeOutboxItem
    try {
      item = this.relayRevokeOutbox.enqueue(binding)
    } catch (error) {
      console.error('[runtime] Failed to persist Relay device cleanup:', error)
      return false
    }
    try {
      this.mobileRelayPairingProvider?.onDeviceRevokeQueued(item)
    } catch (error) {
      console.warn('[runtime] Failed to notify Relay cleanup worker:', error)
    }
    return true
  }
}
