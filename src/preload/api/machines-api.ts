import type {
  MachineActionResult,
  MachineConnection,
  MachineExpiryWarning,
  MachineProgressEvent,
  MachineProviderKey,
  MachineProviderSnapshot,
  MachineRecord,
  MachineTarget,
  MachineWorkAtRisk
} from '../../shared/machine-inventory'
import type { MachineLifetime } from '../../shared/machine-provider-protocol'

export type MachinesApi = {
  /** Cached inventories; never runs a provider. */
  snapshots: () => Promise<MachineActionResult<MachineProviderSnapshot[]>>
  list: (args: {
    providerKey: MachineProviderKey
    maxAgeMs?: number
    force?: boolean
  }) => Promise<MachineActionResult<MachineProviderSnapshot>>
  get: (args: MachineTarget) => Promise<MachineActionResult<MachineRecord>>
  create: (args: {
    providerKey: MachineProviderKey
    operationId: string
    name: string
    lifetime: MachineLifetime
    ttlSeconds?: number
    image?: string
  }) => Promise<MachineActionResult<MachineRecord>>
  cancelCreate: (args: { operationId: string }) => Promise<MachineActionResult<boolean>>
  sleep: (args: MachineTarget) => Promise<MachineActionResult<MachineRecord>>
  /** `operationId` tags this wake's `onProgress` events. */
  wake: (
    args: MachineTarget & { operationId?: string }
  ) => Promise<MachineActionResult<MachineRecord>>
  archive: (args: MachineTarget) => Promise<MachineActionResult<MachineRecord>>
  delete: (args: MachineTarget) => Promise<MachineActionResult<MachineRecord>>
  connect: (
    args: MachineTarget & { operationId?: string }
  ) => Promise<MachineActionResult<MachineConnection>>
  onChanged: (callback: (snapshot: MachineProviderSnapshot) => void) => () => void
  /**
   * Reads uncommitted and unpushed work on a machine from its Orca server (5 s per read).
   * `value: null` means it could not be read: say so, never treat it as nothing at risk.
   */
  workAtRisk: (args: MachineTarget) => Promise<MachineActionResult<MachineWorkAtRisk | null>>
  /** Expiry warnings main already raised for machines that still exist (for a reloaded window). */
  expiryWarnings: () => Promise<MachineActionResult<MachineExpiryWarning[]>>
  /** Main raised a temporary machine's 15-minute warning (its desktop notification is main's). */
  onExpiryWarning: (callback: (warning: MachineExpiryWarning) => void) => () => void
  /** Provider stderr for a create, wake or connect the UI tagged with an operationId. */
  onProgress: (callback: (event: MachineProgressEvent) => void) => () => void
}
