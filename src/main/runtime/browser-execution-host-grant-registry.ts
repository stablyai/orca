type GrantState = {
  token: symbol
  owners: Set<symbol>
  revocations: Map<symbol, () => void>
}

export class BrowserExecutionHostGrantRegistry {
  private readonly grants = new Map<string, GrantState>()

  grant(key: string): { release: () => void } {
    const existing = this.grants.get(key)
    if (existing) {
      this.revoke(key, existing)
    }
    const state = this.createState(key)
    this.grants.set(key, state)
    return this.acquire(key, state)
  }

  retain(key: string): { release: () => void } {
    const state = this.grants.get(key) ?? this.createState(key)
    this.grants.set(key, state)
    return this.acquire(key, state)
  }

  require(key: string): void {
    if (!this.grants.has(key)) {
      throw new Error('browser_tunnel_execution_host_not_granted')
    }
  }

  link(key: string, onRevoked: () => void): () => void {
    const state = this.grants.get(key)
    if (!state) {
      throw new Error('browser_tunnel_execution_host_not_granted')
    }
    const token = Symbol(key)
    state.revocations.set(token, onRevoked)
    return () => state.revocations.delete(token)
  }

  clear(): void {
    for (const [key, state] of this.grants) {
      this.revoke(key, state)
    }
  }

  private createState(key: string): GrantState {
    return { token: Symbol(key), owners: new Set(), revocations: new Map() }
  }

  private acquire(key: string, state: GrantState): { release: () => void } {
    const owner = Symbol(key)
    state.owners.add(owner)
    return { release: () => this.release(key, state, owner) }
  }

  private release(key: string, state: GrantState, owner: symbol): void {
    if (this.grants.get(key)?.token !== state.token || !state.owners.delete(owner)) {
      return
    }
    if (state.owners.size === 0) {
      this.revoke(key, state)
    }
  }

  private revoke(key: string, state: GrantState): void {
    if (this.grants.get(key)?.token !== state.token) {
      return
    }
    this.grants.delete(key)
    state.owners.clear()
    const revocations = [...state.revocations.values()]
    state.revocations.clear()
    for (const revoke of revocations) {
      revoke()
    }
  }
}
