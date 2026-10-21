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
  MachineProviderKey,
  MachineProviderSnapshot
} from '../../shared/machine-inventory'
import { readMachineInventoryStore, writeMachineInventoryStore } from './machine-inventory-store'
import { runMachineProviderVerb, type MachineProviderSource } from './machine-provider-process'

export type MachineProviderEntry = {
  providerKey: MachineProviderKey
  name: string
  source: MachineProviderSource
}

export type MachineProviderClientDeps = {
  userDataPath: string
  listProviders: () => readonly MachineProviderEntry[]
  onChanged?: (snapshot: MachineProviderSnapshot) => void
  runVerb?: typeof runMachineProviderVerb
  now?: () => number
}

export type MachineProviderCallArgs = {
  machineId?: string
  operationId?: string
  params?: Record<string, unknown>
  signal?: AbortSignal
}

/** Runs provider verbs with the stored account context and owns the persisted inventory. */
export class MachineProviderClient {
  private readonly store: MachineInventoryStore
  private readonly writable: boolean
  private readonly capabilitiesChecked = new Set<string>()

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

  /** Applies a change to one provider's inventory, persists, and publishes its snapshot. */
  commit<T>(provider: MachineProviderEntry, change: (inventory: MachineProviderInventory) => T): T {
    const result = change(this.inventory(provider.providerKey))
    if (this.writable) {
      writeMachineInventoryStore(this.deps.userDataPath, this.store)
    }
    this.deps.onChanged?.(this.snapshot(provider))
    return result
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
        ...(args.signal ? { signal: args.signal } : {})
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
