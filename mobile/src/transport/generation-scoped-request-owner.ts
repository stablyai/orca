// Sync scope on every read/load and publish only through owner-issued generation leases, so retired replies cannot repopulate cache.
// A caller displaying returned values directly still needs its own display fence.
// Logical authority, physical authentication and capability epochs are distinct; each owner chooses its invalidating scope signals.

const LEASE_STATE: unique symbol = Symbol('generation-scoped-request-lease')
const LEASE_VALUE: unique symbol = Symbol('generation-scoped-request-lease-value')

type RequestLeaseState = {
  readonly key: string
  readonly generation: number
  readonly owner: symbol
}

// The private brand prevents callers minting leases or reading their generation.
export type RequestLease<Value> = {
  readonly [LEASE_STATE]: RequestLeaseState
  // The phantom callback makes Value invariant so incompatible owners cannot exchange leases.
  readonly [LEASE_VALUE]?: (value: Value) => void
}

// Expose only a read-only currency probe; loaders publish solely by returning their value.
export type RequestCurrency = {
  readonly isCurrent: () => boolean
}

type RequestCommitVerdict = 'committed' | 'retired-generation' | 'foreign-owner'

// Compare workspace/epoch scope members by identity, including client instances.
export type RequestScope = readonly RequestScopeMember[]

// Exclude symbol/bigint because descriptions can collide and bigint has no JSON encoding.
type RequestScopeMember = string | number | boolean | null | undefined | object

/** The domain half of a key. The owner supplies the scope half, so two workspaces cannot share one. */
type RequestParameters = Readonly<Record<string, string | number | boolean>>

export type LoadedRequest<Value> = {
  readonly lease: RequestLease<Value>
  readonly value: Value
}

// Separate JSON-encoded key halves with NUL, which cannot occur literally in either encoding.
const KEY_SEPARATOR = String.fromCharCode(0)

function parameterKey(parameters: RequestParameters): string {
  return Object.keys(parameters)
    .sort()
    .map((name) => `${JSON.stringify(name)}=${JSON.stringify(parameters[name])}`)
    .join(KEY_SEPARATOR)
}

export class GenerationScopedRequestOwner<Params extends RequestParameters, Value> {
  private readonly owner = Symbol('generation-scoped-request-owner')
  private readonly values = new Map<string, Value>()
  private readonly inFlight = new Map<string, Promise<LoadedRequest<Value> | null>>()
  private readonly references = new WeakMap<WeakKey, number>()
  private referenceCount = 0
  private currentGeneration = 0
  private observedScope: string | null = null

  // Reading an unseen scope retires state and advances generation, so never call from render.
  read(scope: RequestScope, parameters: Params): Value | undefined {
    return this.values.get(this.enter(scope, parameters))
  }

  // Coalesce by owner-built key and return a generation lease; stale loaders may return null before sending anything.
  load(
    scope: RequestScope,
    parameters: Params,
    fn: (currency: RequestCurrency) => Promise<Value | null>
  ): Promise<LoadedRequest<Value> | null> {
    const key = this.enter(scope, parameters)
    return this.inFlight.get(key) ?? this.start(key, fn)
  }

  commit(lease: RequestLease<Value>, value: Value): RequestCommitVerdict {
    const state = lease[LEASE_STATE]
    if (state.owner !== this.owner) {
      return 'foreign-owner'
    }
    if (state.generation !== this.currentGeneration) {
      return 'retired-generation'
    }
    this.values.set(state.key, value)
    return 'committed'
  }

  /** Bumps the generation even when the scope came back to where it started, as in A to B to A. */
  reset(): void {
    this.retire()
  }

  private start(
    key: string,
    fn: (currency: RequestCurrency) => Promise<Value | null>
  ): Promise<LoadedRequest<Value> | null> {
    const state: RequestLeaseState = { key, generation: this.currentGeneration, owner: this.owner }
    const lease: RequestLease<Value> = { [LEASE_STATE]: state }
    // Create probes per physical request; joiners reuse its promise, and retirement clears the joinable map.
    const currency: RequestCurrency = {
      isCurrent: () => state.generation === this.currentGeneration
    }
    let loaded: Promise<Value | null>
    try {
      // Invoke synchronously to preserve wire ordering against sibling requests.
      loaded = fn(currency)
    } catch (error) {
      loaded = Promise.reject(error instanceof Error ? error : new Error(String(error)))
    }
    const request: Promise<LoadedRequest<Value> | null> = loaded.then(
      (value) => {
        this.settle(key, request)
        return value === null ? null : { lease, value }
      },
      (error: unknown) => {
        this.settle(key, request)
        throw error
      }
    )
    this.inFlight.set(key, request)
    return request
  }

  /** Only the request still mapped to this key may clear it: a retired one no longer owns the slot. */
  private settle(key: string, request: Promise<LoadedRequest<Value> | null>): void {
    if (this.inFlight.get(key) === request) {
      this.inFlight.delete(key)
    }
  }

  private enter(scope: RequestScope, parameters: Params): string {
    const scopeKey = this.scopeKey(scope)
    if (this.observedScope !== scopeKey) {
      if (this.observedScope !== null) {
        this.retire()
      }
      this.observedScope = scopeKey
    }
    return `${scopeKey}${KEY_SEPARATOR}${parameterKey(parameters)}`
  }

  private retire(): void {
    this.currentGeneration++
    this.values.clear()
    // Dropped rather than awaited: a retired request may still settle, but nothing shares it now.
    this.inFlight.clear()
  }

  private scopeKey(scope: RequestScope): string {
    return scope
      .map((member) => {
        const reference =
          typeof member === 'function'
            ? member
            : typeof member === 'object' && member
              ? member
              : null
        // Use per-owner ordinals for references so scopes match only the same instances.
        if (!reference) {
          return `${typeof member}:${JSON.stringify(member) ?? String(member)}`
        }
        let ordinal = this.references.get(reference)
        if (ordinal === undefined) {
          ordinal = ++this.referenceCount
          this.references.set(reference, ordinal)
        }
        return `reference:${ordinal}`
      })
      .join(KEY_SEPARATOR)
  }
}
