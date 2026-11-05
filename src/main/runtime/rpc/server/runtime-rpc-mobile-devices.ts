import type {
  RelayDeviceBinding,
  RelayRevokeOutboxItem
} from '../../mobile-cloud-relay/relay-revoke-outbox'
import type {
  DelegatedPhone,
  DelegatedMobileDeviceSyncResult
} from '../../../../shared/delegated-mobile-device-contract'
import type { DeviceEntry } from './pairing/device-entry'
import { RuntimeRpcRequestAdmission } from './runtime-rpc-request-admission'

// Why: below dispatch so a caller-bound RPC context can revoke and mint mobile devices.
export class RuntimeRpcMobileDevices extends RuntimeRpcRequestAdmission {
  private onPushUnregisterQueued?: () => void

  async revokeMobileDevice(deviceId: string): Promise<boolean> {
    const device = this.deviceRegistry?.getDevice(deviceId)
    const revoked = device?.scope === 'mobile' && this.revokeDevicesNow([device])
    if (revoked) {
      this.mobileDesktopRelay?.phonesChanged()
    }
    return revoked
  }

  revokeRuntimeAccess(deviceId: string): boolean {
    const device = this.deviceRegistry?.getDevice(deviceId)
    return device?.scope === 'runtime' && this.revokeDevicesNow([device])
  }

  private revokeDevicesNow(roots: readonly DeviceEntry[]): boolean {
    const registry = this.deviceRegistry
    if (!registry) {
      return false
    }
    // Saves adopt disk deletions, so capture every descendant's cleanup facts before the first write.
    const paired = registry.listDevices()
    const plan: DeviceEntry[] = []
    const visited = new Set<string>()
    const visit = (device: DeviceEntry): void => {
      if (visited.has(device.deviceId)) {
        return
      }
      visited.add(device.deviceId)
      for (const child of paired) {
        if (child.parentDeviceId === device.deviceId || child.forkedFrom === device.deviceId) {
          visit(child)
        }
      }
      plan.push(device)
    }
    roots.forEach(visit)
    for (const device of plan) {
      const { deviceId } = device
      // Keep ancestors until child cleanup is durable so retry can rediscover them.
      if (device.scope === 'mobile') {
        if (device.relayBinding && !this.queueRelayDeviceRevoke(device.relayBinding)) {
          return false
        }
        this.queuePushUnregister(deviceId, device.pushRegistration?.registrationId)
      }
      registry.removeDevice(deviceId)
      if (device.scope === 'mobile') {
        this.mobileRelayPairingProvider?.onDemandStateChanged?.()
      }
      this.runtime.forgetClientNavigationState(deviceId)
      this.mobileSocketWiring?.terminateDeviceConnections(deviceId)
    }
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
    const dropped = registry
      .listDelegatedMobileDevices(parentDeviceId)
      .filter((child) => !child.phoneKey || !wanted.has(child.phoneKey))
    if (!this.revokeDevicesNow(dropped)) {
      throw new Error('delegated_device_revoke_failed')
    }

    let devices = registry.upsertDelegatedMobileDevices(parent, phones)
    // A child removed on disk meanwhile is dropped by the save; one rerun mints it fresh.
    if (devices.length < phones.length) {
      const current = registry.getDevice(parentDeviceId)
      if (current?.scope !== 'runtime') {
        throw new Error('delegated_device_parent_unavailable')
      }
      devices = registry.upsertDelegatedMobileDevices(current, phones)
    }
    return {
      devices: devices.map((device) => ({
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
