import type { IPtyProvider } from '../providers/types'

// Why: best-effort sweeps can share one pre-shutdown inventory; proof paths must re-list.
export function withSharedPtyProviderProcessSnapshot(provider: IPtyProvider): IPtyProvider {
  let snapshot: Promise<Awaited<ReturnType<IPtyProvider['listProcesses']>>> | null = null
  return new Proxy(provider, {
    get(target, property) {
      if (property !== 'listProcesses') {
        // Why: provider-internal live re-lists must bypass the proxy snapshot.
        const member: unknown = Reflect.get(target, property)
        return typeof member === 'function' ? member.bind(target) : member
      }
      return async (opts?: { deadlineMs?: number }) => {
        const pending = (snapshot ??= target.listProcesses(opts))
        try {
          return await pending
        } catch {
          // Why: coalesce the recovery scan too, or every waiter retries the same failed relay inventory.
          if (snapshot === pending) {
            snapshot = target.listProcesses(opts)
          }
          const retry = snapshot ?? target.listProcesses(opts)
          snapshot = retry
          return retry
        }
      }
    }
  })
}
