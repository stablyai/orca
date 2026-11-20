import type {
  OrchestrationEnvironmentTransport,
  OrchestrationWorkerServer
} from '../environment-transport'
import { OrchestrationError } from '../../orchestration-error'
import { observeEnvironmentStoreReads } from '../../../../../shared/remote-runtime/host-store/runtime-environment-store-read-observation'
import { environmentStoreWriteCount } from '../../../../../shared/remote-runtime/host-store/runtime-environment-store-worker-client'

export type PairingObservation = Awaited<
  ReturnType<typeof observeEnvironmentStoreReads<OrchestrationWorkerServer>>
> & { registryRevision: number }
type RegistryServers = readonly { environmentId: string; name: string }[]

export class CatalogDeadline {
  private readonly expiresAt: number
  private readonly timer: ReturnType<typeof setTimeout> | undefined
  private readonly listeners = new Set<() => void>()
  private expired = false

  constructor(milliseconds = Infinity) {
    this.expiresAt = Date.now() + milliseconds
    if (Number.isFinite(milliseconds)) {
      this.timer = setTimeout(() => {
        this.expired = true
        for (const listener of this.listeners) {
          listener()
        }
        this.listeners.clear()
      }, milliseconds)
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
  private readonly lists = new CatalogOwnerReadSlots<
    { servers: RegistryServers } | { error: unknown }
  >()
  private readonly pairings = new CatalogOwnerReadSlots<PairingObservation>()

  constructor(private readonly transport: OrchestrationEnvironmentTransport) {}

  invalidate(): void {
    this.revision++
    this.observations.clear()
  }

  isCurrent(observation: PairingObservation | undefined): observation is PairingObservation {
    return (
      !!observation?.current &&
      observation.registryRevision === this.revision &&
      observation.generation === environmentStoreWriteCount()
    )
  }

  current(environmentId: string): PairingObservation | undefined {
    const observation = this.observations.get(environmentId)
    return this.isCurrent(observation) ? observation : undefined
  }

  async list(deadline: CatalogDeadline): Promise<RegistryServers> {
    const result = await this.lists.read('registry', deadline, async () => {
      try {
        return { servers: (await this.transport.list?.()) ?? [] }
      } catch (error) {
        return { error }
      }
    })
    if (result && 'servers' in result) {
      return result.servers
    }
    if (result?.error instanceof OrchestrationError) {
      throw result.error
    }
    throw new OrchestrationError(
      result ? 'runtime_error' : 'runtime_timeout',
      'Worker placement registry enumeration did not complete.',
      { effectsApplied: false, reason: 'discovery_incomplete', phase: 'registry' }
    )
  }

  resolve(
    environmentId: string,
    deadline: CatalogDeadline
  ): Promise<PairingObservation | undefined> {
    return this.pairings.read(environmentId, deadline, async () => {
      const registryRevision = this.revision
      const observation = {
        ...(await observeEnvironmentStoreReads(
          async () => await this.transport.resolve(environmentId),
          environmentStoreWriteCount
        )),
        registryRevision
      }
      if (this.isCurrent(observation)) {
        this.observations.set(environmentId, observation)
      }
      return observation
    })
  }
}
