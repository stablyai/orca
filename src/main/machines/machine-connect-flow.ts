import type {
  MachineConnection,
  MachineProviderKey,
  MachineRecord
} from '../../shared/machine-inventory'
import {
  MachineProviderError,
  type MachineAccess,
  type ProviderMachine
} from '../../shared/machine-provider-protocol'
import {
  connectMachineOrcaServer,
  connectMachineSsh,
  machineEndpointChanged,
  machineSshTargetId,
  type MachinePairing,
  type MachineSshTargets
} from './machine-connect'
import { findRecord, markUnreachable, patchRecord } from './machine-inventory-records'
import type { MachineProviderClient, MachineProviderEntry } from './machine-provider-client'

type MachineFetch = (
  providerKey: MachineProviderKey,
  machineId: string
) => Promise<{ record: MachineRecord; machine?: ProviderMachine }>

/**
 * Connects a machine's access. A failure never removes its SSH target; it marks the machine
 * unreachable, and a failure on cached access asks the provider once in case the machine moved.
 */
export class MachineConnectFlow {
  constructor(
    private readonly client: MachineProviderClient,
    private readonly deps: { sshTargets: MachineSshTargets; pairing: MachinePairing },
    private readonly fetch: MachineFetch
  ) {}

  async connect(providerKey: MachineProviderKey, machineId: string): Promise<MachineConnection> {
    const provider = this.client.provider(providerKey)
    const cached = findRecord(this.client.inventory(providerKey), machineId)
    // Cached ssh access is reused; pairing codes are never stored, so orca-server always asks.
    const reusable = cached?.state === 'running' && cached.access?.kind === 'ssh' ? cached : null
    const live = reusable ? null : await this.fetch(providerKey, machineId)
    try {
      return await this.connectTo(provider, live?.record ?? reusable, live?.machine?.access, cached)
    } catch (error) {
      if (reusable) {
        // The machine may have come back on a new endpoint; ask once, retry only if it moved.
        const fresh = await this.fetch(providerKey, machineId).catch(() => null)
        if (fresh?.machine && machineEndpointChanged(reusable.access, fresh.machine.access)) {
          return this.connectOrMark(provider, fresh.record, fresh.machine.access, cached)
        }
      }
      // The target stays: worktrees are keyed to it and the next connect may succeed.
      this.client.commit(provider, (inventory) => markUnreachable(inventory, machineId, error))
      throw error
    }
  }

  private async connectOrMark(
    provider: MachineProviderEntry,
    record: MachineRecord,
    access: MachineAccess | undefined,
    previous: MachineRecord | undefined
  ): Promise<MachineConnection> {
    try {
      return await this.connectTo(provider, record, access, previous)
    } catch (error) {
      this.client.commit(provider, (inventory) => markUnreachable(inventory, record.id, error))
      throw error
    }
  }

  private async connectTo(
    provider: MachineProviderEntry,
    record: MachineRecord | null,
    liveAccess: MachineAccess | undefined,
    previous: MachineRecord | undefined
  ): Promise<MachineConnection> {
    const access = liveAccess ?? record?.access
    if (!record || record.state !== 'running' || !access) {
      throw new MachineProviderError(
        'unavailable',
        `${record?.name ?? 'The machine'} is ${record?.state ?? 'unknown'}.`
      )
    }
    const patch = (fields: Partial<MachineRecord>): void => {
      this.client.commit(provider, (inventory) => patchRecord(inventory, record.id, fields))
    }
    if (access.kind === 'ssh') {
      // Recorded before connecting: the target exists from here on, even if this connect fails.
      patch({ sshTargetId: machineSshTargetId(provider.providerKey, record.id) })
      const result = await connectMachineSsh(this.deps.sshTargets, record, access)
      patch({ lastError: undefined })
      return { kind: 'ssh', ...result }
    }
    const result = await connectMachineOrcaServer(
      this.deps.pairing,
      { ...record, runtimeEnvironmentId: previous?.runtimeEnvironmentId },
      access,
      previous?.pairingCodeSha256
    )
    patch({ runtimeEnvironmentId: result.runtimeEnvironmentId, lastError: undefined })
    return { kind: 'orca-server', ...result }
  }
}
