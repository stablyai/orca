import { appendMethodsToRegistry, type RpcAnyMethod, type RpcAnyMethodDeclaration } from '../core'
import { withoutMethodsThisHostDoesNotServe } from '../methods/terminal/session-terminal-scrollback'
import type { LazyRpcMethodGroup } from '../methods/lazy-rpc-method-groups'

/** Deduplicates and caches on-demand RPC method group loads into a dispatcher's mutable registry. */
export class LazyRpcMethodResolver {
  readonly registry = new Map<string, RpcAnyMethod>()
  private readonly loaded = new Set<LazyRpcMethodGroup>()
  private readonly pending = new Map<LazyRpcMethodGroup, Promise<void>>()

  constructor(
    methods: readonly RpcAnyMethodDeclaration[],
    private readonly loaders: readonly LazyRpcMethodGroup[]
  ) {
    appendMethodsToRegistry(this.registry, withoutMethodsThisHostDoesNotServe(methods))
  }

  get hasLoaders(): boolean {
    return this.loaders.length > 0
  }

  async ensureLoaded(methodName: string): Promise<void> {
    for (const group of this.loaders) {
      if (this.registry.has(methodName)) {
        return
      }
      if (this.loaded.has(group) || !group.matches(methodName)) {
        continue
      }
      let load = this.pending.get(group)
      if (!load) {
        load = group
          .load()
          .then((loaded) => {
            appendMethodsToRegistry(this.registry, withoutMethodsThisHostDoesNotServe(loaded), {
              ignoreDuplicates: true
            })
            this.loaded.add(group)
          })
          .finally(() => {
            this.pending.delete(group)
          })
        this.pending.set(group, load)
      }
      await load
    }
  }
}
