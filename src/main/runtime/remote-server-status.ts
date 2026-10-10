import {
  stripAnsiEscapeSequences,
  TERMINAL_CONTROL_CHARACTER_PATTERN
} from '../../shared/ansi-escape-sequences'
import type {
  RemoteServerStatus,
  RemoteServerGrant,
  RemoteServerClient
} from '../../shared/remote-server-status'
import type { DeviceEntry, DeviceRegistry } from './device-registry'
import type { MobileSocketWiring } from './rpc/mobile-socket-wiring'

const MAX_STATUS_ENTRIES = 100
const MAX_STATUS_NAME_LENGTH = 160

function validGrant(device: DeviceEntry): boolean {
  return (
    !!device &&
    typeof device.deviceId === 'string' &&
    device.deviceId.length > 0 &&
    device.deviceId.length <= 160 &&
    typeof device.token === 'string' &&
    device.token.length > 0 &&
    typeof device.name === 'string' &&
    (device.scope === 'runtime' || device.scope === 'mobile') &&
    Number.isSafeInteger(device.pairedAt) &&
    device.pairedAt >= 0 &&
    Number.isSafeInteger(device.lastSeenAt) &&
    device.lastSeenAt >= 0
  )
}

function grantStatus(device: DeviceEntry): RemoteServerGrant {
  return {
    deviceId: device.deviceId,
    name: stripAnsiEscapeSequences(device.name)
      .replace(TERMINAL_CONTROL_CHARACTER_PATTERN, '')
      .replace(/[\r\n\t]+/g, ' ')
      .trim()
      .slice(0, MAX_STATUS_NAME_LENGTH),
    scope: device.scope,
    createdAt: device.pairedAt,
    lastSeenAt: device.lastSeenAt > 0 ? device.lastSeenAt : null
  }
}

export function collectRemoteServerStatus(
  listener: RemoteServerStatus['listener'],
  registry: Pick<DeviceRegistry, 'statusAvailable' | 'listDevices'> | null,
  wiring: Pick<MobileSocketWiring, 'getAuthenticatedConnections'> | null
): RemoteServerStatus {
  const devices = registry?.listDevices()
  if (
    !registry?.statusAvailable ||
    !devices ||
    !devices.every(validGrant) ||
    new Set(devices.map((device) => device.deviceId)).size !== devices.length
  ) {
    return {
      listener,
      grants: { state: 'unavailable' },
      connectedClients: { state: 'unavailable' }
    }
  }
  const grants: Extract<RemoteServerStatus['grants'], { state: 'available' }> = {
    state: 'available',
    total: devices.length,
    pending: 0,
    byScope: { runtime: 0, mobile: 0 },
    entries: [],
    truncated: devices.length > MAX_STATUS_ENTRIES
  }
  const byId = new Map<string, DeviceEntry>()
  for (const device of devices) {
    byId.set(device.deviceId, device)
    grants.byScope[device.scope] += 1
    if (device.lastSeenAt === 0) {
      grants.pending += 1
    }
    if (grants.entries.length < MAX_STATUS_ENTRIES) {
      grants.entries.push(grantStatus(device))
    }
  }
  if (!wiring) {
    return { listener, grants, connectedClients: { state: 'unavailable' } }
  }
  const clients = new Map<string, RemoteServerClient>()
  let connectionCount = 0
  const byScope = { runtime: 0, mobile: 0 }
  for (const socket of wiring.getAuthenticatedConnections()) {
    const device = byId.get(socket.deviceId)
    // Revocation can precede the socket close callback.
    if (!device || device.scope !== socket.scope) {
      continue
    }
    let client = clients.get(device.deviceId)
    if (!client) {
      const { deviceId, name, scope } = grantStatus(device)
      client = { deviceId, name, scope, connectionCount: 0, transports: { direct: 0, relay: 0 } }
      clients.set(deviceId, client)
      byScope[scope] += 1
    }
    client.connectionCount += 1
    client.transports[socket.transport] += 1
    connectionCount += 1
  }
  return {
    listener,
    grants,
    connectedClients: {
      state: 'available',
      count: clients.size,
      connectionCount,
      byScope,
      entries: Array.from(clients.values()).slice(0, MAX_STATUS_ENTRIES),
      truncated: clients.size > MAX_STATUS_ENTRIES
    }
  }
}
