import { MachineProviderError, type ProviderMachine } from '../../shared/machine-provider-protocol'
import { isConfirmedMachineTransition } from '../../shared/machine-provider-transitions'
import type {
  MachineConnection,
  MachineProviderKey,
  MachineProviderSnapshot,
  MachineRecord
} from '../../shared/machine-inventory'
import { machineSshTargetId, type MachinePairing, type MachineSshTargets } from './machine-connect'
import { MachineConnectFlow } from './machine-connect-flow'
import { sshTargetStarts, type SshTargetStartWindow } from '../ssh/ssh-target-start-window'
import { pollWhileMachineState } from './machine-state-polling'
import { MachineCreateFlow, isUnknownOutcome, type MachineCreateParams } from './machine-create'
import {
  applyInventory,
  applyMachine,
  failureOf,
  isInventoryFresh,
  markGone,
  markUnreachable,
  patchRecord,
  pruneGoneRecords
} from './machine-inventory-records'
import {
  MachineProviderClient,
  type MachineProviderClientDeps,
  type MachineProviderEntry
} from './machine-provider-client'

const WAKE_POLL_LIMIT_MS = 180_000

export type { MachineCreateParams } from './machine-create'
export type { MachineProviderEntry } from './machine-provider-client'

export type MachineServiceDeps = MachineProviderClientDeps & {
  sshTargets: MachineSshTargets
  pairing: MachinePairing
  removeSshTarget: (id: string) => Promise<void>
  /** Whether a repo or workspace on this host runs on an execution host id; prunes gone rows. */
  isHostReferenced?: (hostId: string) => boolean
  delay?: (ms: number) => Promise<void>
  /** Defaults to the process-wide window the managed server tunnel also reads. */
  starts?: SshTargetStartWindow
}

type Mutation = 'sleep' | 'wake' | 'archive' | 'delete'

export class MachineService {
  private readonly client: MachineProviderClient
  private readonly creates: MachineCreateFlow
  private readonly connections: MachineConnectFlow
  private readonly listFlights = new Map<string, Promise<MachineProviderSnapshot>>()
  private readonly mutationFlights = new Map<
    string,
    { verb: Mutation; done: Promise<MachineRecord> }
  >()
  private readonly consecutiveFailures = new Map<string, number>()

  constructor(private readonly deps: MachineServiceDeps) {
    this.client = new MachineProviderClient(deps)
    this.creates = new MachineCreateFlow(this.client, {
      refresh: (providerKey) => this.list(providerKey, { force: true }),
      read: async (providerKey, machineId, onStderr) =>
        (await this.fetch(providerKey, machineId, onStderr)).record,
      delay: (ms) => this.delay(ms)
    })
    this.connections = new MachineConnectFlow(
      this.client,
      { ...deps, starts: deps.starts ?? sshTargetStarts, delay: (ms) => this.delay(ms) },
      (key, id, onStderr) => this.fetch(key, id, onStderr)
    )
  }

  /** Cached state only; never runs a provider. */
  snapshots(): MachineProviderSnapshot[] {
    return this.client.providers().map((provider) => this.client.snapshot(provider))
  }

  /** The persisted expiry-warning dedupe, kept with the inventory it is keyed by. */
  readonly expiryWarningLog = {
    has: (key: string) => this.client.hasWarnedExpiry(key),
    mark: (key: string, liveKeys: ReadonlySet<string>) =>
      this.client.markWarnedExpiry(key, liveKeys)
  }

  /** Per-provider single-flight; a failing provider backs off unless the caller forces it. */
  async list(
    providerKey: MachineProviderKey,
    options: { maxAgeMs?: number; force?: boolean } = {}
  ): Promise<MachineProviderSnapshot> {
    const provider = this.client.provider(providerKey)
    const failures = this.consecutiveFailures.get(providerKey) ?? 0
    const inventory = this.client.inventory(providerKey)
    if (
      !options.force &&
      isInventoryFresh(inventory, this.client.now(), failures, options.maxAgeMs)
    ) {
      return this.client.snapshot(provider)
    }
    const inFlight = this.listFlights.get(providerKey)
    if (inFlight && !options.force) {
      return inFlight
    }
    // A forced list must start after anything it follows (a create, a cancel), not join an older one.
    const run = (): Promise<MachineProviderSnapshot> => this.runList(provider)
    const start = inFlight ? inFlight.then(run, run) : run()
    const flight = start.finally(() => {
      if (this.listFlights.get(providerKey) === flight) {
        this.listFlights.delete(providerKey)
      }
    })
    this.listFlights.set(providerKey, flight)
    return flight
  }

  async get(providerKey: MachineProviderKey, machineId: string): Promise<MachineRecord> {
    return (await this.fetch(providerKey, machineId)).record
  }

  create(
    providerKey: MachineProviderKey,
    params: MachineCreateParams,
    options: { operationId?: string } = {}
  ): Promise<MachineRecord> {
    return this.creates
      .create(providerKey, params, options.operationId)
      .then((record) => this.connections.noteStarted(record))
  }

  cancelCreate(operationId: string): boolean {
    return this.creates.cancel(operationId)
  }

  sleep(providerKey: MachineProviderKey, machineId: string): Promise<MachineRecord> {
    return this.mutate(providerKey, machineId, 'sleep')
  }

  /** `operationId` tags the wake's stderr progress events. */
  wake(
    providerKey: MachineProviderKey,
    machineId: string,
    options: { operationId?: string } = {}
  ): Promise<MachineRecord> {
    const start = (): Promise<MachineRecord> =>
      this.mutate(providerKey, machineId, 'wake', options.operationId)
    // Opening a worktree right after Sleep waits out the sleep (or archive), then wakes.
    const flight = this.mutationFlights.get(`${providerKey}\0${machineId}`)
    const after = flight && flight.verb !== 'wake' && flight.verb !== 'delete' ? flight : null
    return this.connections.trackWake(
      providerKey,
      machineId,
      after ? after.done.then(start, start) : start()
    )
  }

  archive(providerKey: MachineProviderKey, machineId: string): Promise<MachineRecord> {
    return this.mutate(providerKey, machineId, 'archive')
  }

  delete(providerKey: MachineProviderKey, machineId: string): Promise<MachineRecord> {
    return this.mutate(providerKey, machineId, 'delete')
  }

  connect(
    providerKey: MachineProviderKey,
    machineId: string,
    options: { operationId?: string } = {}
  ): Promise<MachineConnection> {
    return this.connections.connect(providerKey, machineId, options.operationId)
  }

  /** One provider read; the raw answer carries what records never keep (pairing codes). */
  async fetch(
    providerKey: MachineProviderKey,
    machineId: string,
    onStderr?: (chunk: string) => void
  ): Promise<{ record: MachineRecord; machine?: ProviderMachine }> {
    const provider = this.client.provider(providerKey)
    const read = this.client.fence.readStarted()
    let machine: ProviderMachine
    try {
      machine = await this.client.callForMachine(provider, 'get', { machineId, onStderr })
    } catch (error) {
      if (error instanceof MachineProviderError && error.code === 'not-found') {
        return {
          record: this.client.commitRead(provider, machineId, read, (inventory) =>
            markGone(inventory, machineId)
          )
        }
      }
      this.client.markUnreachableSince(provider, machineId, read, error)
      throw error
    }
    const record = this.client.commitRead(provider, machineId, read, (inventory) =>
      applyMachine(inventory, providerKey, machine, this.client.now())
    )
    return { record, machine }
  }

  private async runList(provider: MachineProviderEntry): Promise<MachineProviderSnapshot> {
    const key = provider.providerKey
    const read = this.client.fence.readStarted()
    try {
      const response = await this.client.call(provider, 'list')
      if (response.kind !== 'inventory') {
        throw new MachineProviderError('invalid-response', 'list did not return an inventory.')
      }
      this.consecutiveFailures.delete(key)
      this.client.commit(provider, (inventory) => {
        applyInventory(inventory, key, response.machines, this.client.now(), (machineId) =>
          this.client.fence.changedSince(key, machineId, read)
        )
        if (this.deps.isHostReferenced) {
          pruneGoneRecords(inventory, this.deps.isHostReferenced)
        }
      })
    } catch (error) {
      this.consecutiveFailures.set(key, (this.consecutiveFailures.get(key) ?? 0) + 1)
      this.client.commit(provider, (inventory) => {
        inventory.lastFailure = failureOf(error, this.client.now())
        // A machine a newer lifecycle result settled was reached since; it is not unreachable.
        for (const machine of inventory.machines) {
          if (!this.client.fence.changedSince(key, machine.id, read)) {
            markUnreachable(inventory, machine.id, error)
          }
        }
      })
    }
    return this.client.snapshot(provider)
  }

  /** Per-machine single-flight: a repeat joins, a different action is refused. */
  private mutate(
    providerKey: MachineProviderKey,
    machineId: string,
    verb: Mutation,
    operationId?: string
  ): Promise<MachineRecord> {
    const flightKey = `${providerKey}\0${machineId}`
    const inFlight = this.mutationFlights.get(flightKey)
    if (inFlight) {
      return inFlight.verb === verb
        ? inFlight.done
        : Promise.reject(
            new MachineProviderError('conflict', `Another action is running on ${machineId}.`)
          )
    }
    const done = this.runMutation(providerKey, machineId, verb, operationId)
      .then((record) => this.connections.noteStopped(record))
      .finally(() => this.mutationFlights.delete(flightKey))
    this.mutationFlights.set(flightKey, { verb, done })
    return done
  }

  private async runMutation(
    providerKey: MachineProviderKey,
    machineId: string,
    verb: Mutation,
    operationId: string | undefined
  ): Promise<MachineRecord> {
    const provider = this.client.provider(providerKey)
    const onStderr =
      verb === 'wake' ? this.client.progress(provider, 'wake', operationId, machineId) : undefined
    if (!(await this.client.capabilities(provider)).verbs.includes(verb)) {
      throw new MachineProviderError('unsupported', `${provider.name} does not support ${verb}.`)
    }
    let machine: ProviderMachine
    try {
      machine = await this.client.callForMachine(provider, verb, { machineId, onStderr })
    } catch (error) {
      if (
        verb === 'delete' &&
        error instanceof MachineProviderError &&
        error.code === 'not-found'
      ) {
        return this.finishDelete(provider, machineId)
      }
      if (!isUnknownOutcome(error)) {
        throw error
      }
      return this.reconcile(provider, machineId, verb)
    }
    if (!isConfirmedMachineTransition(verb, machine.state)) {
      return this.reconcile(provider, machineId, verb)
    }
    if (verb === 'delete') {
      return this.finishDelete(provider, machineId)
    }
    const record = this.client.commitMutation(provider, machineId, (inventory) =>
      applyMachine(inventory, providerKey, machine, this.client.now())
    )
    return pollWhileMachineState(record, verb === 'wake' ? 'waking' : 'stopping', {
      read: async () => (await this.fetch(providerKey, machineId, onStderr)).record,
      delay: (ms) => this.delay(ms),
      now: () => this.client.now(),
      deadline: this.client.now() + WAKE_POLL_LIMIT_MS
    }).then((settled) => this.client.settled(provider, settled))
  }

  /** "Checking what happened": one read, never a re-run of the mutation. */
  private async reconcile(
    provider: MachineProviderEntry,
    machineId: string,
    verb: Mutation
  ): Promise<MachineRecord> {
    // Why no unreachable mark first: the answer may be odd, not lost; only a failed read says so.
    const record = await this.get(provider.providerKey, machineId)
    // A delete the read confirms (the machine is gone) still owes its cleanup.
    return verb === 'delete' && record.state === 'gone'
      ? this.finishDelete(provider, machineId)
      : record
  }

  private async finishDelete(
    provider: MachineProviderEntry,
    machineId: string
  ): Promise<MachineRecord> {
    // Explicit delete is the one path that removes the machine's SSH target.
    await this.deps
      .removeSshTarget(machineSshTargetId(provider.providerKey, machineId))
      .catch(() => undefined)
    return this.client.commitMutation(provider, machineId, (inventory) => {
      markGone(inventory, machineId)
      return patchRecord(inventory, machineId, { sshTargetId: undefined })
    })
  }

  private delay(ms: number): Promise<void> {
    return this.deps.delay
      ? this.deps.delay(ms)
      : new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)))
  }
}
