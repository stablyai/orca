import type { DeviceEntry } from '../device-registry'

/** Paired desktop/web clients that relayed to each configured server, by server environment id. */
export class RelayedRuntimeClients {
  private readonly byEnvironment = new Map<string, Set<string>>()

  add(environmentId: string, deviceId: string): void {
    const clients = this.byEnvironment.get(environmentId) ?? new Set<string>()
    clients.add(deviceId)
    this.byEnvironment.set(environmentId, clients)
  }

  /** True when any server held a device for one of these clients, so their syncs must drop it. */
  forget(deviceIds: Iterable<string>): boolean {
    let forgot = false
    for (const deviceId of deviceIds) {
      for (const clients of this.byEnvironment.values()) {
        forgot = clients.delete(deviceId) || forgot
      }
    }
    return forgot
  }

  /** Live clients first, then most recently seen, so stale browser sessions lose the sync cap. */
  listFor(
    environmentId: string,
    devices: readonly DeviceEntry[],
    isLive: (deviceId: string) => boolean
  ): DeviceEntry[] {
    const clients = this.byEnvironment.get(environmentId)
    if (!clients) {
      return []
    }
    return devices
      .filter((device) => device.scope === 'runtime' && clients.has(device.deviceId))
      .map((device) => ({ device, live: isLive(device.deviceId) }))
      .sort((a, b) => Number(b.live) - Number(a.live) || b.device.lastSeenAt - a.device.lastSeenAt)
      .map(({ device }) => device)
  }
}
