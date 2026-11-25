import type { OrcadPeerDesktopsResult } from '../../../../../shared/remote-runtime/orcad-lifecycle/orcad-peer-desktops-contract'
import { sanitizeDeviceLabel } from '../../../../../shared/remote-runtime/pairing/device-key-proof'
import type { DeviceEntry, DeviceOrcaAccount } from './device-entry'

const UNNAMED_DESKTOP = 'another Orca'
// Lost contact isn't proof an Orca left: a closed control socket still counts while it reconnects.
export const DECLARED_CLIENT_RECONNECT_GRACE_MS = 60_000

type Declaration = { clientInstanceId: string; deviceId: string }
type AccountDeclaration = {
  deviceId: string
  account: DeviceOrcaAccount | null
  clientInstanceId?: string
}

/**
 * R39: which desktop installation each authenticated control socket belongs to. A desktop declares
 * on its control socket after auth (and after every reconnect); the tag goes with that socket.
 * Desktops sharing one token row stay distinct, and a desktop's own other sockets never count.
 */
export class DeclaredDesktopClients {
  private readonly byConnection = new Map<string, Declaration>()
  // The Orca account each desktop socket last declared (null: none), with its row and installation.
  private readonly accounts = new Map<string, AccountDeclaration>()
  // Installations whose last declared socket closed recently, by id, until their grace ends.
  private readonly reconnecting = new Map<string, { deviceId: string; until: number }>()

  // Monotonic: a wall-clock jump can't stretch or cut the grace.
  constructor(private readonly now: () => number = () => performance.now()) {}

  declare(connectionId: string, deviceId: string, clientInstanceId: string): void {
    this.byConnection.set(connectionId, { clientInstanceId, deviceId })
    this.reconnecting.delete(clientInstanceId)
  }

  declareAccount(connectionId: string, declaration: AccountDeclaration): void {
    this.accounts.set(connectionId, declaration)
  }

  accountOf(connectionId: string): DeviceOrcaAccount | null {
    return this.accounts.get(connectionId)?.account ?? null
  }

  instanceOf(connectionId: string): string | undefined {
    return (
      this.accounts.get(connectionId)?.clientInstanceId ??
      this.byConnection.get(connectionId)?.clientInstanceId
    )
  }

  /** What an installation on this paired row declares now: how a phone it relays or paired is
   *  named. Scoped to the row, so installations elsewhere that chose the same id never match. */
  accountOfInstance(deviceId: string, clientInstanceId: string): DeviceOrcaAccount | null {
    for (const declaration of this.accounts.values()) {
      if (
        declaration.deviceId === deviceId &&
        declaration.clientInstanceId === clientInstanceId &&
        declaration.account
      ) {
        return declaration.account
      }
    }
    return null
  }

  forget(connectionId: string): void {
    this.accounts.delete(connectionId)
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
