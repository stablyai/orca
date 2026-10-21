import { randomUUID } from 'node:crypto'
import {
  MachineProviderError,
  isConfirmedMachineTransition,
  type MachineLifetime,
  type MachineProviderCapabilities
} from '../../shared/machine-provider-protocol'
import type { MachineProviderKey, MachineRecord } from '../../shared/machine-inventory'
import { applyMachine, dropPendingCreate } from './machine-inventory-records'
import type { MachineProviderClient, MachineProviderEntry } from './machine-provider-client'

const CANCEL_RECONCILE_DELAYS_MS = [0, 10_000, 60_000]

export type MachineCreateParams = {
  name: string
  lifetime: MachineLifetime
  ttlSeconds?: number
  image?: string
}

/**
 * Create is never retried. The operationId is persisted before the provider runs and providers
 * tag the machine with it, so an unknown outcome is settled by finding that tag in a list.
 */
export class MachineCreateFlow {
  private readonly controllers = new Map<string, AbortController>()
  private readonly flights = new Map<string, Promise<MachineRecord>>()

  constructor(
    private readonly client: MachineProviderClient,
    private readonly refresh: (providerKey: MachineProviderKey) => Promise<unknown>,
    private readonly delay: (ms: number) => Promise<void>
  ) {}

  /** Single-flight per operationId: a retried request joins the running create. */
  create(
    providerKey: MachineProviderKey,
    params: MachineCreateParams,
    operationId: string = randomUUID()
  ): Promise<MachineRecord> {
    const inFlight = this.flights.get(operationId)
    if (inFlight) {
      return inFlight
    }
    const flight = this.run(providerKey, params, operationId).finally(() =>
      this.flights.delete(operationId)
    )
    this.flights.set(operationId, flight)
    return flight
  }

  private async run(
    providerKey: MachineProviderKey,
    params: MachineCreateParams,
    operationId: string
  ): Promise<MachineRecord> {
    const provider = this.client.provider(providerKey)
    assertCreateParams(await this.client.capabilities(provider), params)
    this.client.commit(provider, (inventory) =>
      inventory.pendingCreates.push({
        operationId,
        startedAt: this.client.now(),
        name: params.name,
        lifetime: params.lifetime
      })
    )
    const controller = new AbortController()
    this.controllers.set(operationId, controller)
    try {
      const machine = await this.client.callForMachine(provider, 'create', {
        operationId,
        params: { ...params },
        signal: controller.signal
      })
      if (!isConfirmedMachineTransition('create', machine.state)) {
        throw new MachineProviderError('invalid-response', `create reported ${machine.state}.`)
      }
      return this.client.commit(provider, (inventory) => {
        dropPendingCreate(inventory, operationId)
        return applyMachine(
          inventory,
          providerKey,
          { ...machine, creatingOperationId: operationId },
          this.client.now()
        )
      })
    } catch (error) {
      if (!isUnknownOutcome(error)) {
        this.client.commit(provider, (inventory) => dropPendingCreate(inventory, operationId))
        throw error
      }
      if (controller.signal.aborted) {
        void this.reconcileCancelled(provider, operationId)
        throw error
      }
      const found = await this.findCreated(provider, operationId)
      if (found) {
        return found
      }
      throw error
    } finally {
      this.controllers.delete(operationId)
    }
  }

  /** Kills the local process; the pending row stays until a list proves what happened. */
  cancel(operationId: string): boolean {
    const controller = this.controllers.get(operationId)
    controller?.abort()
    return controller !== undefined
  }

  private async findCreated(
    provider: MachineProviderEntry,
    operationId: string
  ): Promise<MachineRecord | null> {
    await this.refresh(provider.providerKey)
    return (
      this.client
        .inventory(provider.providerKey)
        .machines.find(
          (machine) => machine.creatingOperationId === operationId && machine.state !== 'gone'
        ) ?? null
    )
  }

  // Killing local ssh does not stop a remote create, which may only appear in list later.
  private async reconcileCancelled(
    provider: MachineProviderEntry,
    operationId: string
  ): Promise<void> {
    let elapsed = 0
    for (const at of CANCEL_RECONCILE_DELAYS_MS) {
      await this.delay(at - elapsed)
      elapsed = at
      if (await this.findCreated(provider, operationId).catch(() => null)) {
        return
      }
    }
  }
}

// Outcome unknown: the provider may have acted, so reconcile with a read instead of re-running.
const UNKNOWN_OUTCOME_CODES = new Set(['timeout', 'invalid-response', 'unavailable', 'cancelled'])

export function isUnknownOutcome(error: unknown): boolean {
  return error instanceof MachineProviderError && UNKNOWN_OUTCOME_CODES.has(error.code)
}

function assertCreateParams(
  capabilities: MachineProviderCapabilities,
  params: MachineCreateParams
): void {
  if (!capabilities.verbs.includes('create')) {
    throw new MachineProviderError('unsupported', 'This provider cannot create machines.')
  }
  if (!capabilities.lifetimes.includes(params.lifetime)) {
    throw new MachineProviderError(
      'unsupported',
      `This provider has no ${params.lifetime} machines.`
    )
  }
  if (
    params.ttlSeconds !== undefined &&
    capabilities.maxTtlSeconds !== undefined &&
    params.ttlSeconds > capabilities.maxTtlSeconds
  ) {
    throw new MachineProviderError(
      'unsupported',
      'The requested lifetime exceeds the provider maximum.'
    )
  }
}
