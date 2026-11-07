import { useCallback, useSyncExternalStore } from 'react'
import { AppState } from 'react-native'
import type { RpcClient } from '../transport/rpc-client'
import { getProjectSectionsResource } from './project-sections-resource'

const pending = { kind: 'pending' } as const
const noSubscription = () => () => {}
const pendingSnapshot = () => pending

export function useOwnerProjectSections(client: RpcClient | null, active: boolean) {
  const resource = client ? getProjectSectionsResource(client) : null
  const subscribe = useCallback(
    (listener: () => void) =>
      active && resource ? resource.subscribe(listener, AppState) : noSubscription(),
    [active, resource]
  )
  const answer = useSyncExternalStore(subscribe, resource?.getSnapshot ?? pendingSnapshot)
  return { answer, refresh: resource?.refresh }
}
