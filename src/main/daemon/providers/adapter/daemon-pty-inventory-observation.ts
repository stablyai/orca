export type InventoryRequest = {
  /** Set for a single-ID observation: it records only this ID's evidence and never commits. */
  scope?: string
  sequence: number
  transportEpoch: number
  owners: Map<string, string | undefined>
  replacements: Map<string, string | undefined>
  retirements: Map<string, Set<string | undefined>>
}

export class DaemonPtyInventoryObservation {
  private sessions: Map<string, string | undefined> | null = null
  private sequence = 0
  private committedSequence = 0
  private transportEpoch = 0
  private pending = new Set<InventoryRequest>()
  private scoped = new Map<string, Set<InventoryRequest>>()

  constructor(
    private readonly activeIds: Set<string>,
    private readonly incarnations: ReadonlyMap<string, string>
  ) {}

  has(id: string): boolean {
    return this.sessions?.has(id) ?? false
  }

  currentIncarnation(id: string): string | undefined {
    return this.activeIds.has(id)
      ? this.incarnations.get(id)
      : (this.sessions?.get(id) ?? this.incarnations.get(id))
  }

  begin(scope?: string): InventoryRequest {
    const request: InventoryRequest = {
      scope,
      sequence: ++this.sequence,
      transportEpoch: this.transportEpoch,
      owners:
        scope === undefined
          ? new Map([...this.activeIds].map((id) => [id, this.incarnations.get(id)]))
          : new Map(),
      replacements: new Map(),
      retirements: new Map()
    }
    if (scope === undefined) {
      this.pending.add(request)
    } else {
      const bucket = this.scoped.get(scope) ?? new Set()
      bucket.add(request)
      this.scoped.set(scope, bucket)
    }
    return request
  }

  /**
   * Whether what this request listed for `id` is still current: no reconnect, no same-ID spawn
   * and no exit of that incarnation since it began.
   */
  stillApplies(request: InventoryRequest, id: string, incarnation: string | undefined): boolean {
    const retired = request.retirements.get(id)
    return (
      (request.scope === undefined || request.scope === id) &&
      request.transportEpoch === this.transportEpoch &&
      !request.replacements.has(id) &&
      !(retired && (retired.has(undefined) || retired.has(incarnation)))
    )
  }

  end(request: InventoryRequest): void {
    if (request.scope === undefined) {
      this.pending.delete(request)
      return
    }
    const bucket = this.scoped.get(request.scope)
    bucket?.delete(request)
    if (bucket?.size === 0) {
      this.scoped.delete(request.scope)
    }
  }

  private observers(id: string): InventoryRequest[] {
    return [...this.pending, ...(this.scoped.get(id) ?? [])]
  }

  reset(): void {
    this.sessions = null
    this.transportEpoch += 1
  }

  spawned(id: string, incarnation: string | undefined): void {
    this.sessions?.delete(id)
    for (const request of this.observers(id)) {
      request.replacements.set(id, incarnation)
    }
  }

  retire(id: string, incarnation: string | undefined): boolean {
    const current = this.currentIncarnation(id)
    if (current !== undefined && current !== incarnation) {
      return false
    }
    const listed = this.sessions?.get(id)
    if (incarnation === undefined || listed === undefined || listed === incarnation) {
      this.sessions?.delete(id)
    }
    for (const request of this.observers(id)) {
      const retired = request.retirements.get(id) ?? new Set()
      retired.add(incarnation)
      request.retirements.set(id, retired)
      if (incarnation === undefined || request.replacements.get(id) === incarnation) {
        request.replacements.delete(id)
      }
    }
    return true
  }

  commit(request: InventoryRequest, alive: ReadonlyMap<string, string | undefined>): void {
    if (
      request.scope !== undefined ||
      request.transportEpoch !== this.transportEpoch ||
      request.sequence <= this.committedSequence
    ) {
      return
    }
    const sessions = new Map(alive)
    for (const [id, incarnation] of sessions) {
      const retired = request.retirements.get(id)
      if (
        (retired &&
          (incarnation === undefined || retired.has(undefined) || retired.has(incarnation))) ||
        (request.replacements.has(id) &&
          (incarnation === undefined || request.replacements.get(id) !== incarnation))
      ) {
        sessions.delete(id)
      }
    }
    for (const [id, incarnation] of request.owners) {
      if (
        !alive.has(id) &&
        !request.retirements.has(id) &&
        !request.replacements.has(id) &&
        this.incarnations.get(id) === incarnation
      ) {
        this.activeIds.delete(id)
      }
    }
    this.sessions = sessions
    this.committedSequence = request.sequence
  }
}
