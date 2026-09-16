/**
 * Owns the cache, the in-flight identity and the generation token for one family of requests, so a
 * reply that outlived its scope has nowhere to land.
 *
 * The fence is structural rather than a callback a caller may forget. `read` and `load` are handed
 * the scope and build the key themselves, and a scope the owner has not seen retires everything it
 * held before it answers. A reply is published only through `commit`, which refuses a lease whose
 * generation has moved; a commit that beat the owner's own notice still cannot be read, because the
 * next read syncs first. What `committed` does not say is that the value in the caller's own hand is
 * fresh: a caller that displays it directly still needs whatever fences its display, which for the
 * file-search pilot is the sequence counter it already had.
 *
 * Three epochs may appear in a scope and they are not the same thing: the logical authority epoch
 * (`StableLogicalRpcClient.getGeneration`, advanced by `migrateTo`), the physical authenticated
 * session (`authenticationGeneration` inside `direct-rpc-client.ts`) and the negotiated capability
 * epoch. Which of them retires a given owner's data is that owner's decision, made by what its
 * callers put in the scope.
 */

const LEASE_STATE: unique symbol = Symbol('generation-scoped-request-lease')
const LEASE_VALUE: unique symbol = Symbol('generation-scoped-request-lease-value')

type RequestLeaseState = {
  readonly key: string
  readonly generation: number
  readonly owner: symbol
}

/**
 * The only way to publish into an owner, and unforgeable: the brand is module-private, so no caller
 * can mint one or read the generation it pins.
 */
export type RequestLease<Value> = {
  readonly [LEASE_STATE]: RequestLeaseState
  // Phantom, never present at runtime: makes a lease invariant in Value so two owners' leases are
  // not interchangeable.
  readonly [LEASE_VALUE]?: (value: Value) => void
}

/** Named rather than boolean: a refused publish says which fence refused it. */
type RequestCommitVerdict = 'committed' | 'retired-generation' | 'foreign-owner'

/**
 * What retires a request: the workspace identity plus whichever epoch signals this owner treats as
 * invalidating. Members are compared by identity, so a client instance may sit in one directly.
 */
export type RequestScope = readonly RequestScopeMember[]

/**
 * Symbol and bigint are excluded rather than rejected at runtime: two symbols share a description
 * freely and a registered one is not a valid WeakMap key, and a bigint is not JSON-serialisable.
 */
type RequestScopeMember = string | number | boolean | null | undefined | object

/** The domain half of a key. The owner supplies the scope half, so two workspaces cannot share one. */
type RequestParameters = Readonly<Record<string, string | number | boolean>>

export type LoadedRequest<Value> = {
  readonly lease: RequestLease<Value>
  readonly value: Value
}

// Both halves of a key are JSON-encoded and joined on a character no encoding emits, so no two
// distinct scope-and-parameter pairs can spell the same key.
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

  /**
   * What this owner holds for these parameters, or nothing once the scope moved. Not a getter: an
   * unseen scope retires everything held and advances the generation before this answers, so it must
   * not be called from render.
   */
  read(scope: RequestScope, parameters: Params): Value | undefined {
    return this.values.get(this.enter(scope, parameters))
  }

  /**
   * Coalesces on the owner-built key and hands back a lease pinned to the generation the request
   * started in. `fn` returns the value; it is given nothing it could publish with.
   */
  load(
    scope: RequestScope,
    parameters: Params,
    fn: () => Promise<Value | null>
  ): Promise<LoadedRequest<Value> | null> {
    const key = this.enter(scope, parameters)
    return this.inFlight.get(key) ?? this.start(key, fn)
  }

  /** Publishes `value` only while the lease's generation is still the owner's. */
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
    fn: () => Promise<Value | null>
  ): Promise<LoadedRequest<Value> | null> {
    const lease: RequestLease<Value> = {
      [LEASE_STATE]: { key, generation: this.currentGeneration, owner: this.owner }
    }
    let loaded: Promise<Value | null>
    try {
      // Called here rather than off a microtask so the request reaches the wire in the turn the
      // caller asked for it, which is what orders it against its siblings.
      loaded = fn()
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

  /** Syncs the observed scope, then returns the key. Every read path goes through here. */
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
        // A primitive is its own identity; everything else gets a per-owner ordinal, so two scopes
        // match only when they hold the same instances.
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
