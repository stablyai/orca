import type {
  OrchestrationEnvironmentTransport,
  OrchestrationWorkerServer
} from '../environment-transport'
import { OrchestrationError } from '../../orchestration-error'
import { observeEnvironmentStoreReads } from '../../../../../shared/remote-runtime/host-store/runtime-environment-store-read-observation'
import { environmentStoreWriteCount } from '../../../../../shared/remote-runtime/host-store/runtime-environment-store-worker-client'

type RegistryObservation<T> = Awaited<ReturnType<typeof observeEnvironmentStoreReads<T>>> & {
  registryRevision: number
}
export type PairingObservation = RegistryObservation<OrchestrationWorkerServer>
type RegistryServers = readonly { environmentId: string; name: string }[]
type ListResult = RegistryObservation<RegistryServers | undefined> | { error: unknown }

export class CatalogDeadline {
  private readonly expiresAt: number
  private readonly timer: ReturnType<typeof setTimeout> | undefined
  private readonly listeners = new Set<() => void>()
  private expired = false

  constructor(milliseconds = Infinity) {
    this.expiresAt = Date.now() + milliseconds
    if (Number.isFinite(milliseconds)) {
      this.timer = setTimeout(() => this.close(), milliseconds)
    }
  }

  get active(): boolean {
    return !this.expired && Date.now() < this.expiresAt
  }

  onExpire(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  close(): void {
    clearTimeout(this.timer)
    this.expired = true
    for (const listener of this.listeners) {
      listener()
    }
    this.listeners.clear()
  }
}

/** One completion handler per underlying operation; expired waiters detach from stalled work. */
export class CatalogOwnerRead<T> {
  private result: { value: T | undefined } | undefined
  private readonly listeners = new Set<(value: T | undefined) => void>()

  constructor(start: () => Promise<T | undefined>) {
    void Promise.resolve()
      .then(start)
      .then(
        (value) => this.finish(value),
        () => this.finish(undefined)
      )
  }

  private finish(value: T | undefined): void {
    this.result = { value }
    for (const listener of this.listeners) {
      listener(value)
    }
    this.listeners.clear()
  }

  wait(deadline: CatalogDeadline): Promise<T | undefined> {
    if (!deadline.active) {
      return Promise.resolve(undefined)
    }
    if (this.result) {
      return Promise.resolve(this.result.value)
    }
    return new Promise((resolve) => {
      const finish = (value: T | undefined): void => {
        stop()
        this.listeners.delete(finish)
        resolve(deadline.active ? value : undefined)
      }
      const stop = deadline.onExpire(() => finish(undefined))
      this.listeners.add(finish)
    })
  }
}

class CatalogOwnerReadSlots<T> {
  private readonly slots = new Map<string, CatalogOwnerRead<T>>()

  read(key: string, deadline: CatalogDeadline, start: () => Promise<T>): Promise<T | undefined> {
    if (!deadline.active) {
      return Promise.resolve(undefined)
    }
    let pending = this.slots.get(key)
    if (!pending) {
      pending = new CatalogOwnerRead(async () => {
        try {
          if (!deadline.active) {
            return undefined
          }
          return await start()
        } finally {
          this.slots.delete(key)
        }
      })
      this.slots.set(key, pending)
    }
    return pending.wait(deadline)
  }
}
export class CatalogOwnerRegistry {
  private revision = 0
  private readonly observations = new Map<string, PairingObservation>()
  private readonly lists = new CatalogOwnerReadSlots<ListResult>()
  private readonly pairings = new CatalogOwnerReadSlots<PairingObservation>()

  constructor(private readonly transport: OrchestrationEnvironmentTransport) {}

  invalidate(): void {
    this.revision++
    this.observations.clear()
  }

  private currentProof<T>(observation: RegistryObservation<T>): boolean {
    return (
      observation.current &&
      observation.registryRevision === this.revision &&
      observation.generation === environmentStoreWriteCount()
    )
  }

  isCurrent(
    observation: PairingObservation | undefined,
    environmentId?: string
  ): observation is PairingObservation {
    return (
      !!observation &&
      this.currentProof(observation) &&
      (environmentId === undefined || environmentId === observation.value.environmentId)
    )
  }

  current(environmentId: string): PairingObservation | undefined {
    const observation = this.observations.get(environmentId)
    return this.isCurrent(observation) ? observation : undefined
  }

  async list(deadline: CatalogDeadline): Promise<ListResult | undefined> {
    const read = () =>
      this.lists.read('registry', deadline, async () => {
        try {
          return await this.observe(async () => await this.transport.list?.())
        } catch (error) {
          return { error }
        }
      })
    const first = await read()
    return first && 'value' in first && !this.currentProof(first) ? await read() : first
  }

  currentServers(result: ListResult | undefined): RegistryServers {
    if (result && 'value' in result && Array.isArray(result.value) && this.currentProof(result)) {
      return result.value
    }
    if (result && 'error' in result && result.error instanceof OrchestrationError) {
      throw result.error
    }
    throw new OrchestrationError(
      result ? 'runtime_error' : 'runtime_timeout',
      'Worker placement registry enumeration did not complete.',
      { effectsApplied: false, reason: 'discovery_incomplete', phase: 'registry' }
    )
  }

  private async observe<T>(read: () => Promise<T>): Promise<RegistryObservation<T>> {
    const registryRevision = this.revision
    return {
      ...(await observeEnvironmentStoreReads(read, environmentStoreWriteCount)),
      registryRevision
    }
  }

  resolve(
    environmentId: string,
    deadline: CatalogDeadline
  ): Promise<PairingObservation | undefined> {
    return this.pairings.read(environmentId, deadline, async () => {
      const observation = await this.observe(
        async () => await this.transport.resolve(environmentId)
      )
      if (this.isCurrent(observation, environmentId)) {
        this.observations.set(environmentId, observation)
      } else {
        this.observations.delete(environmentId)
      }
      return observation
    })
  }
}
