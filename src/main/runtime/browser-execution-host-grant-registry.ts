type GrantState = {
  token: symbol
  revocations: Map<symbol, () => void>
}

export class BrowserExecutionHostGrantRegistry {
  private readonly grants = new Map<string, GrantState>()

  grant(key: string): { release: () => void } {
    const existing = this.grants.get(key)
    if (existing) {
      this.revoke(key, existing)
    }
    const state = { token: Symbol(key), revocations: new Map<symbol, () => void>() }
    this.grants.set(key, state)
    return { release: () => this.revoke(key, state) }
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

  private revoke(key: string, state: GrantState): void {
    if (this.grants.get(key)?.token !== state.token) {
      return
    }
    this.grants.delete(key)
    const revocations = [...state.revocations.values()]
    state.revocations.clear()
    for (const revoke of revocations) {
      revoke()
    }
  }
}
