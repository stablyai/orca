import { randomUUID } from 'node:crypto'
import type { MachineProviderVerb } from '../../shared/machine-provider-command'
import {
  MachineProviderError,
  type MachineProviderCapabilities,
  type MachineProviderSuccess,
  type ProviderMachine
} from '../../shared/machine-provider-protocol'
import type {
  MachineInventoryStore,
  MachineProviderInventory,
  MachineProgressEvent,
  MachineProviderKey,
  MachineProviderSnapshot,
  MachineRecord
} from '../../shared/machine-inventory'
import { readMachineInventoryStore, writeMachineInventoryStore } from './machine-inventory-store'
import { runMachineProviderVerb, type MachineProviderSource } from './machine-provider-process'
import { MachineMutationFence } from './machine-mutation-fence'
import { markUnreachable, requireRecord } from './machine-inventory-records'

export type MachineProviderEntry = {
  providerKey: MachineProviderKey
  name: string
  source: MachineProviderSource
}

export type MachineProviderClientDeps = {
  userDataPath: string
  listProviders: () => readonly MachineProviderEntry[]
  onChanged?: (snapshot: MachineProviderSnapshot) => void
  onProgress?: (event: MachineProgressEvent) => void
  /** Stops dialing a gone machine's managed server; its record stays for the Gone link. */
  retireEnvironment?: (environmentId: string) => void
  runVerb?: typeof runMachineProviderVerb
  now?: () => number
}

export type MachineProviderCallArgs = {
  machineId?: string
  operationId?: string
  params?: Record<string, unknown>
  signal?: AbortSignal
  onStderr?: (chunk: string) => void
}

/** Runs provider verbs with the stored account context and owns the persisted inventory. */
export class MachineProviderClient {
  private readonly store: MachineInventoryStore
  private readonly writable: boolean
  private readonly capabilitiesChecked = new Set<string>()
  private readonly retiredEnvironments = new Set<string>()

  constructor(private readonly deps: MachineProviderClientDeps) {
    const loaded = readMachineInventoryStore(deps.userDataPath)
    this.store = loaded.store
    this.writable = loaded.writable
  }

  providers(): readonly MachineProviderEntry[] {
    return this.deps.listProviders()
  }

  provider(providerKey: MachineProviderKey): MachineProviderEntry {
    const provider = this.providers().find((entry) => entry.providerKey === providerKey)
    if (!provider) {
      throw new MachineProviderError('not-found', `No machine provider ${providerKey}.`)
    }
    return provider
  }

  inventory(providerKey: string): MachineProviderInventory {
    const existing = this.store.providers[providerKey]
    if (existing) {
      return existing
    }
    const created: MachineProviderInventory = { machines: [], pendingCreates: [] }
    this.store.providers[providerKey] = created
    return created
  }

  readonly fence = new MachineMutationFence()

  /** A lifecycle result: reads that began before it can no longer overwrite this machine. */
  commitMutation<T>(
    provider: MachineProviderEntry,
    machineId: string,
    change: (inventory: MachineProviderInventory) => T
  ): T {
    const result = this.commit(provider, change)
    this.fence.mutated(provider.providerKey, machineId)
    return result
  }

  /** A lifecycle that polled to its settled state: reads that began before the settle are stale. */
  settled(provider: MachineProviderEntry, record: MachineRecord): MachineRecord {
    this.fence.mutated(provider.providerKey, record.id)
    return record
  }

  /** Loss of contact seen by a read or connect that began at `startedAt`, unless a newer result settled it. */
  markUnreachableSince(
    provider: MachineProviderEntry,
    machineId: string,
    startedAt: number,
    error: unknown
  ): void {
    if (!this.fence.changedSince(provider.providerKey, machineId, startedAt)) {
      this.commit(provider, (inventory) => markUnreachable(inventory, machineId, error))
    }
  }

  /** A read's answer for one machine; dropped when a mutation of it finished since the read began. */
  commitRead(
    provider: MachineProviderEntry,
    machineId: string,
    readStartedAt: number,
    change: (inventory: MachineProviderInventory) => MachineRecord
  ): MachineRecord {
    return this.fence.changedSince(provider.providerKey, machineId, readStartedAt)
      ? requireRecord(this.inventory(provider.providerKey), machineId)
      : this.commit(provider, change)
  }

  /** Applies a change to one provider's inventory, persists, and publishes its snapshot. */
  commit<T>(provider: MachineProviderEntry, change: (inventory: MachineProviderInventory) => T): T {
    const result = change(this.inventory(provider.providerKey))
    this.retireGoneEnvironments(this.inventory(provider.providerKey))
    if (this.writable) {
      writeMachineInventoryStore(this.deps.userDataPath, this.store)
    }
    this.deps.onChanged?.(this.snapshot(provider))
    return result
  }

  hasWarnedExpiry(key: string): boolean {
    return this.store.warnedExpiries?.includes(key) ?? false
  }

  /** Records a warning; keys for machines this host no longer tracks are dropped to stay bounded. */
  markWarnedExpiry(key: string, liveKeys: ReadonlySet<string>): void {
    this.store.warnedExpiries = [
      ...(this.store.warnedExpiries ?? []).filter((existing) => liveKeys.has(existing)),
      key
    ]
    if (this.writable) {
      writeMachineInventoryStore(this.deps.userDataPath, this.store)
    }
  }

  // Once per session per server: the retirement itself persists across launches.
  private retireGoneEnvironments(inventory: MachineProviderInventory): void {
    const retire = this.deps.retireEnvironment
    if (!retire) {
      return
    }
    // A gone SSH machine's deployed server, or the paired server an orca-server machine ran.
    const gone = inventory.machines.filter((machine) => machine.state === 'gone')
    for (const environmentId of gone.flatMap((machine) => [
      machine.managedEnvironmentId,
      machine.runtimeEnvironmentId
    ])) {
      if (environmentId && !this.retiredEnvironments.has(environmentId)) {
        this.retiredEnvironments.add(environmentId)
        try {
          retire(environmentId)
        } catch (error) {
          console.warn(`[machines] could not retire server ${environmentId}:`, error)
        }
      }
    }
  }

  snapshot(provider: MachineProviderEntry): MachineProviderSnapshot {
    const inventory = this.inventory(provider.providerKey)
    return {
      ...inventory,
      providerKey: provider.providerKey,
      name: provider.name,
      machines: [...inventory.machines]
    }
  }

  /** A stderr sink tagged for the UI action that asked for it; none without an operationId. */
  progress(
    provider: MachineProviderEntry,
    verb: MachineProgressEvent['verb'],
    operationId: string | undefined,
    machineId?: string
  ): ((chunk: string) => void) | undefined {
    const onProgress = this.deps.onProgress
    if (!onProgress || operationId === undefined) {
      return undefined
    }
    return (chunk) =>
      onProgress({
        operationId,
        providerKey: provider.providerKey,
        verb,
        stream: 'stderr',
        chunk,
        ...(machineId !== undefined ? { machineId } : {})
      })
  }

  now(): number {
    return (this.deps.now ?? Date.now)()
  }

  /** Fetched once per session; the stored account context is what later requests must echo. */
  async capabilities(provider: MachineProviderEntry): Promise<MachineProviderCapabilities> {
    const key = provider.providerKey
    const inventory = this.inventory(key)
    if (inventory.capabilities && this.capabilitiesChecked.has(key)) {
      return inventory.capabilities
    }
    const response = await this.run(provider, 'capabilities', {}, undefined)
    if (response.kind !== 'capabilities') {
      throw new MachineProviderError('invalid-response', 'capabilities returned the wrong kind.')
    }
    const contextId = response.capabilities.contextId ?? response.contextId
    // Fail closed on an account switch only when there is cached state it could be confused with.
    if (
      inventory.contextId !== undefined &&
      contextId !== inventory.contextId &&
      inventory.machines.some((machine) => machine.state !== 'gone')
    ) {
      throw new MachineProviderError(
        'context-mismatch',
        `${provider.name} is signed in as a different account.`
      )
    }
    this.commit(provider, (current) => {
      current.capabilities = response.capabilities
      current.contextId = contextId
    })
    this.capabilitiesChecked.add(key)
    return response.capabilities
  }

  async call(
    provider: MachineProviderEntry,
    verb: MachineProviderVerb,
    args: MachineProviderCallArgs = {}
  ): Promise<MachineProviderSuccess> {
    await this.capabilities(provider)
    return this.run(provider, verb, args, this.inventory(provider.providerKey).contextId)
  }

  async callForMachine(
    provider: MachineProviderEntry,
    verb: MachineProviderVerb,
    args: MachineProviderCallArgs
  ): Promise<ProviderMachine> {
    const response = await this.call(provider, verb, args)
    if (response.kind !== 'machine') {
      throw new MachineProviderError(
        'invalid-response',
        `Expected a machine, got ${response.kind}.`
      )
    }
    return response.machine
  }

  private async run(
    provider: MachineProviderEntry,
    verb: MachineProviderVerb,
    args: MachineProviderCallArgs,
    contextId: string | undefined
  ): Promise<MachineProviderSuccess> {
    let response: MachineProviderSuccess
    try {
      response = await (this.deps.runVerb ?? runMachineProviderVerb)({
        source: provider.source,
        verb,
        operationId: args.operationId ?? randomUUID(),
        cwd: this.deps.userDataPath,
        ...(args.machineId !== undefined ? { machineId: args.machineId } : {}),
        ...(contextId !== undefined ? { contextId } : {}),
        ...(args.params ? { params: args.params } : {}),
        ...(args.signal ? { signal: args.signal } : {}),
        ...(args.onStderr ? { onStderr: args.onStderr } : {})
      })
    } catch (error) {
      // A sign-in change is exactly when the account must be asked again.
      if (
        error instanceof MachineProviderError &&
        (error.code === 'context-mismatch' || error.code === 'auth-required')
      ) {
        this.capabilitiesChecked.delete(provider.providerKey)
      }
      throw error
    }
    const providerNow = Date.parse(response.now)
    if (!Number.isNaN(providerNow)) {
      this.inventory(provider.providerKey).clockOffsetMs = providerNow - this.now()
    }
    return response
  }
}
