import { buildRegistry, type RpcAnyMethodDeclaration, type RpcRegistry } from './core'

/** Imports the method table on demand, so a server can start answering before handlers load. */
export type RpcMethodLoader = () => Promise<readonly RpcAnyMethodDeclaration[]>

export type RpcMethodSource = readonly RpcAnyMethodDeclaration[] | RpcMethodLoader

/**
 * The dispatcher's registry, built now from a method list or on first use from a loader.
 * Concurrent first calls share one load. A failed load is not cached: those calls fail and the
 * next call tries again.
 */
export class RpcRegistrySource {
  private registry: RpcRegistry | null = null
  private loading: Promise<RpcRegistry> | null = null
  private readonly load: () => Promise<RpcRegistry>

  constructor(
    methods: RpcMethodSource,
    filter: (methods: readonly RpcAnyMethodDeclaration[]) => readonly RpcAnyMethodDeclaration[]
  ) {
    if (typeof methods === 'function') {
      this.load = async () => buildRegistry(filter(await methods()))
    } else {
      const registry = buildRegistry(filter(methods))
      this.registry = registry
      this.load = async () => registry
    }
  }

  /** Synchronous once built, so loaded dispatch keeps its existing timing. */
  get(): RpcRegistry | Promise<RpcRegistry> {
    if (this.registry) {
      return this.registry
    }
    this.loading ??= this.load().then(
      (registry) => {
        this.registry = registry
        this.loading = null
        return registry
      },
      (error: unknown) => {
        this.loading = null
        const reason = error instanceof Error ? error.message : String(error)
        throw new Error(`RPC methods failed to load: ${reason}`, { cause: error })
      }
    )
    return this.loading
  }

  /** Loads now so the first call does not wait on it. Never rejects; a later call retries. */
  async preload(): Promise<void> {
    try {
      await this.get()
    } catch (error) {
      console.warn(`[runtime] ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
