import type { OrcadPeerDesktopsResult } from '../../shared/orcad-peer-desktops-contract'
import { sanitizeDeviceLabel } from '../../shared/device-key-proof'
import type { DeviceEntry } from './device-entry'

const UNNAMED_DESKTOP = 'another Orca'
// Lost contact isn't proof an Orca left: a closed control socket still counts while it reconnects.
export const DECLARED_CLIENT_RECONNECT_GRACE_MS = 60_000

type Declaration = { clientInstanceId: string; deviceId: string }

/**
 * R39: which desktop installation each authenticated control socket belongs to. A desktop declares
 * on its control socket after auth (and after every reconnect); the tag goes with that socket.
 * Desktops sharing one token row stay distinct, and a desktop's own other sockets never count.
 */
export class DeclaredDesktopClients {
  private readonly byConnection = new Map<string, Declaration>()
  // Installations whose last declared socket closed recently, by id, until their grace ends.
  private readonly reconnecting = new Map<string, { deviceId: string; until: number }>()

  // Monotonic: a wall-clock jump can't stretch or cut the grace.
  constructor(private readonly now: () => number = () => performance.now()) {}

  declare(connectionId: string, deviceId: string, clientInstanceId: string): void {
    this.byConnection.set(connectionId, { clientInstanceId, deviceId })
    this.reconnecting.delete(clientInstanceId)
  }

  forget(connectionId: string): void {
    this.sweepExpired()
    const declaration = this.byConnection.get(connectionId)
    this.byConnection.delete(connectionId)
    if (
      declaration &&
      ![...this.byConnection.values()].some(
        (other) => other.clientInstanceId === declaration.clientInstanceId
      )
    ) {
      this.reconnecting.set(declaration.clientInstanceId, {
        deviceId: declaration.deviceId,
        until: this.now() + DECLARED_CLIENT_RECONNECT_GRACE_MS
      })
    }
  }

  peers(
    caller: { connectionId: string; clientInstanceId?: string },
    getDevice: (deviceId: string) => DeviceEntry | null
  ): OrcadPeerDesktopsResult {
    const callerInstance =
      caller.clientInstanceId ?? this.byConnection.get(caller.connectionId)?.clientInstanceId
    const names = new Map<string, string>()
    this.sweepExpired()
    const candidates: [string | null, Declaration][] = [
      ...this.byConnection,
      ...[...this.reconnecting].map(([clientInstanceId, { deviceId }]): [null, Declaration] => [
        null,
        { clientInstanceId, deviceId }
      ])
    ]
    for (const [connectionId, declaration] of candidates) {
      if (
        connectionId === caller.connectionId ||
        declaration.clientInstanceId === callerInstance ||
        names.has(declaration.clientInstanceId)
      ) {
        continue
      }
      const device = getDevice(declaration.deviceId)
      // A revoked, phone or browser-session row is no desktop.
      if (device?.scope !== 'runtime' || device.ephemeral || device.parentDeviceId !== undefined) {
        continue
      }
      names.set(declaration.clientInstanceId, displayName(device.name))
    }
    return { peers: [...names.values()].map((name) => ({ name })) }
  }

  /** Bounded even if nothing asks for peers: every close drops expired graces first. */
  get reconnectingCount(): number {
    return this.reconnecting.size
  }

  private sweepExpired(): void {
    const now = this.now()
    for (const [clientInstanceId, { until }] of this.reconnecting) {
      if (until <= now) {
        this.reconnecting.delete(clientInstanceId)
      }
    }
  }
}

// Startup offers are named "CLI <date>", which says nothing to a person.
function displayName(raw: string): string {
  const name = sanitizeDeviceLabel(raw, UNNAMED_DESKTOP)
  return /^CLI \d/.test(name) ? UNNAMED_DESKTOP : name
}
