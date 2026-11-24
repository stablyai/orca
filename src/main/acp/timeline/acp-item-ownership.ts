export type AcpItemOwner = { readonly turn: string; readonly settled: boolean }

/** Live observations and publication debt outlive the single closed-turn fallback. */
export class AcpItemOwnership {
  private readonly live = new Map<string, AcpItemOwner>()
  private readonly turns = new Map<string, Map<string, AcpItemOwner>>()
  private readonly pending = new Map<string, AcpItemOwner>()
  private readonly ended = new Set<string>()
  private closed: { turn: string | undefined; items: Map<string, AcpItemOwner> } = {
    turn: undefined,
    items: new Map()
  }
  private dirty = new Map<string, AcpItemOwner>()
  private endings = new Set<string>()
  private disposed = false

  open(turn: string): void {
    if (!this.disposed && !this.settled(turn) && !this.turns.has(turn)) {
      this.turns.set(turn, new Map())
    }
  }

  isLive(turn: string): boolean {
    return this.turns.has(turn)
  }

  settled(turn: string): boolean {
    return this.ended.has(turn) || this.closed.turn === turn
  }

  get(key: string): AcpItemOwner | undefined {
    return this.live.get(key) ?? this.pending.get(key) ?? this.closed.items.get(key)
  }

  remember(key: string, turn: string): AcpItemOwner | undefined {
    const items =
      this.turns.get(turn) ?? (this.closed.turn === turn ? this.closed.items : undefined)
    if (this.disposed || (!items && !this.ended.has(turn))) {
      return undefined
    }
    const held = this.get(key)
    if (held?.turn === turn) {
      return held
    }
    const owner = { turn, settled: !this.isLive(turn) }
    items?.set(key, owner)
    if (!owner.settled) {
      this.live.set(key, owner)
    }
    this.pending.set(key, owner)
    this.dirty.set(key, owner)
    return owner
  }

  keys(turn: string): Iterable<string> {
    return this.turns.get(turn)?.keys() ?? []
  }

  end(turn: string): void {
    const items = this.turns.get(turn)
    if (!items) {
      return
    }
    this.turns.delete(turn)
    for (const [key, owner] of items) {
      if (this.live.get(key) === owner) {
        this.live.delete(key)
      }
      const settled = { turn, settled: true }
      items.set(key, settled)
      this.pending.set(key, settled)
      this.dirty.set(key, settled)
    }
    this.closed = { turn, items }
    this.ended.add(turn)
    this.endings.add(turn)
  }

  publication(): (() => void) | undefined {
    if (this.dirty.size === 0 && this.endings.size === 0) {
      return undefined
    }
    const items = this.dirty
    const endings = this.endings
    this.dirty = new Map()
    this.endings = new Set()
    return () => {
      for (const [key, owner] of items) {
        if (this.pending.get(key) === owner) {
          this.pending.delete(key)
        }
      }
      for (const turn of endings) {
        this.ended.delete(turn)
      }
    }
  }

  dispose(): void {
    this.disposed = true
    this.live.clear()
    this.turns.clear()
    this.pending.clear()
    this.ended.clear()
    this.closed.items.clear()
    this.closed.turn = undefined
    this.dirty.clear()
    this.endings.clear()
  }
}
