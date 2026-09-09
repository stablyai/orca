import type { IPtyProvider } from '../providers/types'
import { serializeSessionOperation } from './session-operation-serialization'

export type RouteObservation = {
  epoch: number
  revision: number
  accepted: Map<string, number>
  admission?: { id: string }
}

// All route writers share custody revisions, including observations for unrelated IDs.
export class DaemonSessionRouteAuthority<T extends IPtyProvider> {
  private readonly operations = new Map<string, Promise<void>>()
  private readonly revisions = new Map<string, number>()
  private readonly active = new Map<string, { id: string }>()
  private readonly incarnations = new Map<string, string | undefined>()
  private revision = 0
  private epoch = 0
  private invalidationRevision = 0
  private disposed = false

  constructor(private readonly routes: Map<string, IPtyProvider>) {}

  capture(admission?: { id: string }): RouteObservation {
    return { epoch: this.epoch, revision: this.revision, accepted: new Map(), admission }
  }

  isCurrent(id: string, observation: RouteObservation): boolean {
    const revision = this.revisions.get(id) ?? 0
    return (
      !this.disposed &&
      observation.epoch === this.epoch &&
      (!this.active.has(id) || observation.admission === this.active.get(id)) &&
      (revision <= observation.revision || observation.accepted.get(id) === revision)
    )
  }

  run<R>(id: string, operation: (observation: RouteObservation) => Promise<R>): Promise<R> {
    return serializeSessionOperation(this.operations, id, async () => {
      if (this.disposed) {
        throw new Error('router_disconnected')
      }
      this.advance(id)
      const admission = { id }
      this.active.set(id, admission)
      try {
        return await operation(this.capture(admission))
      } finally {
        this.active.delete(id)
        this.advance(id)
      }
    })
  }

  refreshAdmission(observation: RouteObservation): RouteObservation | null {
    const admission = observation.admission
    if (
      this.disposed ||
      observation.epoch === this.epoch ||
      !admission ||
      this.active.get(admission.id) !== admission ||
      this.routes.has(admission.id) ||
      (this.revisions.get(admission.id) ?? 0) > this.invalidationRevision
    ) {
      return null
    }
    return this.capture(admission)
  }

  incarnation(id: string): string | undefined {
    return this.incarnations.get(id)
  }

  record(id: string, provider: T, incarnation?: string, observation?: RouteObservation): boolean {
    if (this.disposed || (observation && !this.isCurrent(id, observation))) {
      return false
    }
    this.routes.set(id, provider)
    this.incarnations.set(id, incarnation)
    this.advance(id, observation)
    return true
  }

  forget(id: string, provider?: T, observation?: RouteObservation): boolean {
    if (this.disposed || (observation && !this.isCurrent(id, observation))) {
      return false
    }
    if (provider && this.routes.has(id) && this.routes.get(id) !== provider) {
      return false
    }
    this.routes.delete(id)
    this.incarnations.delete(id)
    this.advance(id, observation)
    return true
  }

  exited(id: string, provider: T, incarnation?: string): Promise<void> {
    const epoch = this.epoch
    const commit = async (): Promise<void> => {
      if (
        epoch !== this.epoch ||
        (this.incarnations.has(id) && this.incarnations.get(id) !== incarnation)
      ) {
        return
      }
      this.forget(id, provider)
    }
    return this.operations.has(id)
      ? serializeSessionOperation(this.operations, id, commit)
      : commit()
  }

  invalidateProvider(provider: T): void {
    this.epoch += 1
    for (const [id, routed] of this.routes) {
      if (routed === provider) {
        this.forget(id, provider)
      }
    }
    this.invalidationRevision = this.revision
  }

  dispose(): void {
    this.disposed = true
    this.epoch += 1
  }

  private advance(id: string, observation?: RouteObservation): void {
    this.revisions.set(id, ++this.revision)
    observation?.accepted.set(id, this.revision)
  }
}
