import { useSyncExternalStore } from 'react'
import { usePageBridgeClientIfPresent } from '../transport/client-context.web'

export function useShellStorage(): Readonly<Record<string, string>> | null {
  const client = usePageBridgeClientIfPresent()
  return useSyncExternalStore(
    client?.onStorageUpdate ?? (() => () => undefined),
    () => client?.getShellSession()?.storage ?? null
  )
}
