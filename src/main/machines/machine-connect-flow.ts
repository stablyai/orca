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
  type MachineSshConnectResult,
  type MachineSshTargets
} from './machine-connect'
import type { SshTargetStartWindow } from '../ssh/ssh-target-start-window'
import { findRecord, pairingCodeSha256, patchRecord } from './machine-inventory-records'
import type { MachineProviderClient, MachineProviderEntry } from './machine-provider-client'

type MachineFetch = (
  providerKey: MachineProviderKey,
  machineId: string,
  onStderr?: (chunk: string) => void
) => Promise<{ record: MachineRecord; machine?: ProviderMachine }>

/**
 * Connects a machine's access. A failure never removes its SSH target; it marks the machine
 * unreachable, and a failure on cached access asks the provider once in case the machine moved.
 */
export class MachineConnectFlow {
  constructor(
    private readonly client: MachineProviderClient,
    private readonly deps: {
      sshTargets: MachineSshTargets
      pairing: MachinePairing
      starts: SshTargetStartWindow
      delay: (ms: number) => Promise<void>
    },
    private readonly fetch: MachineFetch
  ) {}

  /** A machine just created or woken; its first dials tolerate sshd still starting. */
  noteStarted(record: MachineRecord): MachineRecord {
    if (record.state === 'running') {
      this.deps.starts.noteStarted(machineSshTargetId(record.providerKey, record.id))
    }
    return record
  }

  /** A machine slept or removed soon after a start fails its dials at once again. */
  noteStopped(record: MachineRecord): MachineRecord {
    if (record.state !== 'running') {
      this.deps.starts.noteStopped(machineSshTargetId(record.providerKey, record.id))
    }
    return record
  }

  /** A pane that dials the machine mid-wake waits for it instead of failing against a stopped host. */
  trackWake(
    providerKey: MachineProviderKey,
    machineId: string,
    wake: Promise<MachineRecord>
  ): Promise<MachineRecord> {
    const woken = wake.then((record) => this.noteStarted(record))
    this.deps.starts.noteStarting(machineSshTargetId(providerKey, machineId), woken)
    return woken
  }

  async connect(
    providerKey: MachineProviderKey,
    machineId: string,
    operationId?: string
  ): Promise<MachineConnection> {
    const provider = this.client.provider(providerKey)
    const since = this.client.fence.readStarted()
    const onStderr = this.client.progress(provider, 'connect', operationId, machineId)
    const cached = findRecord(this.client.inventory(providerKey), machineId)
    // Cached ssh access is reused; pairing codes are never stored, so orca-server always asks.
    const reusable = cached?.state === 'running' && cached.access?.kind === 'ssh' ? cached : null
    const live = reusable ? null : await this.fetch(providerKey, machineId, onStderr)
    try {
      return await this.connectTo(provider, live?.record ?? reusable, live?.machine?.access, cached)
    } catch (error) {
      if (reusable) {
        // The machine may have come back on a new endpoint; ask once, retry only if it moved.
        const fresh = await this.fetch(providerKey, machineId, onStderr).catch(() => null)
        if (fresh?.machine && machineEndpointChanged(reusable.access, fresh.machine.access)) {
          return this.connectOrMark(provider, fresh.record, fresh.machine.access, cached, since)
        }
      }
      // The target stays: worktrees are keyed to it and the next connect may succeed.
      this.client.markUnreachableSince(provider, machineId, since, error)
      throw error
    }
  }

  private async connectOrMark(
    provider: MachineProviderEntry,
    record: MachineRecord,
    access: MachineAccess | undefined,
    previous: MachineRecord | undefined,
    since: number
  ): Promise<MachineConnection> {
    try {
      return await this.connectTo(provider, record, access, previous)
    } catch (error) {
      this.client.markUnreachableSince(provider, record.id, since, error)
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
    // Only a connect that succeeds is a lifecycle result; its own earlier writes don't fence it.
    const patch = (fields: Partial<MachineRecord>): void => {
      this.client.commitMutation(provider, record.id, (inventory) =>
        patchRecord(inventory, record.id, fields)
      )
    }
    if (access.kind === 'ssh') {
      // Recorded before connecting: the target exists from here on, even if this connect fails.
      this.client.commit(provider, (inventory) =>
        patchRecord(inventory, record.id, {
          sshTargetId: machineSshTargetId(provider.providerKey, record.id)
        })
      )
      const result = await this.dialSsh(record, access)
      patch({
        lastError: undefined,
        ...(result.environmentId ? { managedEnvironmentId: result.environmentId } : {})
      })
      return { kind: 'ssh', ...result }
    }
    const result = await connectMachineOrcaServer(
      this.deps.pairing,
      { ...record, runtimeEnvironmentId: previous?.runtimeEnvironmentId },
      access,
      previous?.pairingCodeSha256
    )
    patch({
      runtimeEnvironmentId: result.runtimeEnvironmentId,
      pairingCodeSha256: pairingCodeSha256(access.pairingCode),
      lastError: undefined
    })
    return { kind: 'orca-server', ...result }
  }

  private dialSsh(
    record: MachineRecord,
    access: Extract<MachineAccess, { kind: 'ssh' }>
  ): Promise<MachineSshConnectResult> {
    return this.deps.starts.dial(machineSshTargetId(record.providerKey, record.id), () =>
      connectMachineSsh(this.deps.sshTargets, record, access)
    )
  }
}
