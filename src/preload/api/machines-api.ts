import type {
  MachineActionResult,
  MachineConnection,
  MachineProviderKey,
  MachineProviderSnapshot,
  MachineRecord,
  MachineTarget
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
  wake: (args: MachineTarget) => Promise<MachineActionResult<MachineRecord>>
  archive: (args: MachineTarget) => Promise<MachineActionResult<MachineRecord>>
  delete: (args: MachineTarget) => Promise<MachineActionResult<MachineRecord>>
  connect: (args: MachineTarget) => Promise<MachineActionResult<MachineConnection>>
  onChanged: (callback: (snapshot: MachineProviderSnapshot) => void) => () => void
}
