import { DegradedDaemonPtyProvider } from './degraded-daemon-pty-provider'
import type { DaemonPtyAdapter } from './daemon-pty-adapter'
import { DaemonPtyRouter } from './daemon-pty-router'
import type { IPtyProvider } from '../providers/types'

export type DaemonProvider = DaemonPtyRouter | DaemonPtyAdapter | DegradedDaemonPtyProvider

export function getCurrentDaemonAdapter(provider: DaemonProvider): DaemonPtyAdapter {
  if (provider instanceof DaemonPtyRouter || provider instanceof DegradedDaemonPtyProvider) {
    return provider.getCurrentAdapter()
  }
  return provider
}

export function getLegacyDaemonAdapters(provider: IPtyProvider): DaemonPtyAdapter[] {
  if (provider instanceof DaemonPtyRouter || provider instanceof DegradedDaemonPtyProvider) {
    return [...provider.getLegacyAdapters()]
  }
  return []
}

export function disposeProviderSubscriptionsOnly(provider: DaemonProvider): void {
  if (provider instanceof DaemonPtyRouter) {
    provider.disposeRouterOnly()
    return
  }
  if (provider instanceof DegradedDaemonPtyProvider) {
    provider.disposeProviderOnly()
  }
}

export function getAllDaemonAdapters(provider: DaemonProvider): readonly DaemonPtyAdapter[] {
  return provider instanceof DaemonPtyRouter || provider instanceof DegradedDaemonPtyProvider
    ? provider.getAllAdapters()
    : [provider]
}

// Why: an inventory is authoritative only if every generation answered; otherwise unverifiable.
export async function listEveryDaemonGeneration<T>(
  provider: DaemonProvider,
  list: (adapter: DaemonPtyAdapter) => Promise<T[]>
): Promise<T[] | null> {
  const results = await Promise.allSettled(getAllDaemonAdapters(provider).map(list))
  return results.every((r) => r.status === 'fulfilled')
    ? results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []))
    : null
}
