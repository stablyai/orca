import {
  buildRegistry,
  type RpcAnyMethodDeclaration,
  type RpcMethod,
  type RpcStreamingMethod
} from './core'
import { withoutMethodsThisHostDoesNotServe } from './methods/terminal/session-terminal-scrollback'

export type LazyRpcMethodGroup = {
  readonly matches: (methodName: string) => boolean
  readonly streamingNames?: readonly string[]
  readonly load: () => Promise<readonly RpcAnyMethodDeclaration[]>
}

export function prefixRpcMethodGroup(
  prefixes: readonly string[],
  load: () => Promise<readonly RpcAnyMethodDeclaration[]>,
  options?: { exactNames?: readonly string[]; streamingNames?: readonly string[] }
): LazyRpcMethodGroup {
  const exact = options?.exactNames ? new Set(options.exactNames) : null
  return {
    matches: (name) =>
      (exact?.has(name) ?? false) || prefixes.some((prefix) => name.startsWith(prefix)),
    streamingNames: options?.streamingNames,
    load
  }
}

export class LazyRpcMethodLoader {
  readonly registry: Map<string, RpcMethod | RpcStreamingMethod>
  private readonly inflight = new Map<LazyRpcMethodGroup, Promise<void>>()

  constructor(
    methods: readonly RpcAnyMethodDeclaration[],
    private readonly groups: readonly LazyRpcMethodGroup[]
  ) {
    this.registry = new Map(buildRegistry(withoutMethodsThisHostDoesNotServe(methods)))
  }

  /** Returns a load promise if an unregistered method belongs to a lazy group, else null. */
  ensureMethodLoaded(methodName: string): Promise<void> | null {
    if (this.registry.has(methodName) || this.groups.length === 0) {
      return null
    }
    const group = this.groups.find((entry) => entry.matches(methodName))
    if (!group) {
      return null
    }
    const existing = this.inflight.get(group)
    if (existing) {
      return existing
    }
    const loading = group
      .load()
      .then((methods) => {
        const built = buildRegistry(withoutMethodsThisHostDoesNotServe(methods))
        for (const [name, method] of built) {
          if (this.registry.has(name)) {
            throw new Error(`duplicate_rpc_method:${name}`)
          }
          this.registry.set(name, method)
        }
      })
      .catch((error: unknown) => {
        this.inflight.delete(group)
        throw error
      })
    this.inflight.set(group, loading)
    return loading
  }
}
