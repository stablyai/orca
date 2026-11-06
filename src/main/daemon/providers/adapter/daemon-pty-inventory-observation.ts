type InventoryRequest = {
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

  begin(): InventoryRequest {
    const request: InventoryRequest = {
      sequence: ++this.sequence,
      transportEpoch: this.transportEpoch,
      owners: new Map([...this.activeIds].map((id) => [id, this.incarnations.get(id)])),
      replacements: new Map(),
      retirements: new Map()
    }
    this.pending.add(request)
    return request
  }

  end(request: InventoryRequest): void {
    this.pending.delete(request)
  }

  reset(): void {
    this.sessions = null
    this.transportEpoch += 1
  }

  spawned(id: string, incarnation: string | undefined): void {
    this.sessions?.delete(id)
    for (const request of this.pending) {
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
    for (const request of this.pending) {
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
