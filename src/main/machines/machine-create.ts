import { randomUUID } from 'node:crypto'
import {
  MachineProviderError,
  type MachineLifetime,
  type MachineProviderCapabilities
} from '../../shared/machine-provider-protocol'
import { isConfirmedMachineTransition } from '../../shared/machine-provider-transitions'
import {
  MACHINE_CREATE_RECONCILE_WINDOW_MS,
  type MachineProviderKey,
  type MachineRecord
} from '../../shared/machine-inventory'
import { applyMachine, dropPendingCreate } from './machine-inventory-records'
import type { MachineProviderClient, MachineProviderEntry } from './machine-provider-client'
import { pollWhileMachineState } from './machine-state-polling'

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
    private readonly deps: {
      refresh: (providerKey: MachineProviderKey) => Promise<unknown>
      read: (
        providerKey: MachineProviderKey,
        machineId: string,
        onStderr?: (chunk: string) => void
      ) => Promise<MachineRecord>
      delay: (ms: number) => Promise<void>
    }
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
    // Why before any await: a cancel that arrives while capabilities load must still stop the create.
    const controller = new AbortController()
    this.controllers.set(operationId, controller)
    const flight = this.run(providerKey, params, operationId, controller).finally(() => {
      this.flights.delete(operationId)
      if (this.controllers.get(operationId) === controller) {
        this.controllers.delete(operationId)
      }
    })
    this.flights.set(operationId, flight)
    return flight
  }

  private async run(
    providerKey: MachineProviderKey,
    params: MachineCreateParams,
    operationId: string,
    controller: AbortController
  ): Promise<MachineRecord> {
    const provider = this.client.provider(providerKey)
    assertCreateParams(await this.client.capabilities(provider), params)
    // Nothing was asked of the provider yet, so a cancel here leaves nothing to reconcile.
    if (controller.signal.aborted) {
      throw new MachineProviderError('cancelled', 'The create was canceled before it started.')
    }
    const startedAt = this.client.now()
    this.client.commit(provider, (inventory) =>
      inventory.pendingCreates.push({
        operationId,
        startedAt,
        name: params.name,
        lifetime: params.lifetime
      })
    )
    try {
      const onStderr = this.client.progress(provider, 'create', operationId)
      const machine = await this.client.callForMachine(provider, 'create', {
        operationId,
        params: { ...params },
        signal: controller.signal,
        onStderr
      })
      if (!isConfirmedMachineTransition('create', machine.state)) {
        throw new MachineProviderError('invalid-response', `create reported ${machine.state}.`)
      }
      const created = this.client.commitMutation(provider, machine.id, (inventory) => {
        dropPendingCreate(inventory, operationId)
        return applyMachine(
          inventory,
          providerKey,
          { ...machine, creatingOperationId: operationId },
          this.client.now()
        )
      })
      return this.untilRunning(providerKey, created, startedAt, onStderr)
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
        // An adopted machine may still be creating; it is handed over once it runs, like any other.
        return this.untilRunning(providerKey, found, startedAt)
      }
      throw error
    }
  }

  /** Resolves once the machine runs, so a created machine always has access. */
  private untilRunning(
    providerKey: MachineProviderKey,
    record: MachineRecord,
    startedAt: number,
    onStderr?: (chunk: string) => void
  ): Promise<MachineRecord> {
    return pollWhileMachineState(record, 'creating', {
      read: () => this.deps.read(providerKey, record.id, onStderr),
      delay: this.deps.delay,
      now: () => this.client.now(),
      deadline: startedAt + MACHINE_CREATE_RECONCILE_WINDOW_MS
    }).then((settled) => this.client.settled(this.client.provider(providerKey), settled))
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
    await this.deps.refresh(provider.providerKey)
    return (
      this.client
        .inventory(provider.providerKey)
        .machines.find(
          (machine) => machine.creatingOperationId === operationId && machine.state !== 'gone'
        ) ?? null
    )
  }

  // Killing local ssh does not stop a remote create, which may only appear in list later. Once the
  // local process has exited, two successful lists at least 10 s apart without the tag settle it as
  // never created; a failed list proves nothing and only the later checks can.
  private async reconcileCancelled(
    provider: MachineProviderEntry,
    operationId: string
  ): Promise<void> {
    let elapsed = 0
    let cleanMisses = 0
    for (const at of CANCEL_RECONCILE_DELAYS_MS) {
      await this.deps.delay(at - elapsed)
      elapsed = at
      const listedFrom = this.client.now()
      if (await this.findCreated(provider, operationId).catch(() => null)) {
        return
      }
      const inventory = this.client.inventory(provider.providerKey)
      const listed = !inventory.lastFailure && (inventory.listedAt ?? -1) >= listedFrom
      cleanMisses = listed ? cleanMisses + 1 : 0
      if (cleanMisses >= 2) {
        this.client.commit(provider, (current) => dropPendingCreate(current, operationId))
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
