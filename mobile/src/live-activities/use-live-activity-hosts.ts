import { useEffect, useState } from 'react'
import { AppState } from 'react-native'
import { loadHostCatalog } from '../host-catalog/host-store'
import { useAllHostClients } from '../transport/connection/use-all-host-clients'
import {
  loadLiveActivityPreferences,
  subscribeLiveActivityPreferences
} from './live-activity-preferences'
import { pendingLiveActivityRetirementHosts } from './live-activity-retirement'
import { nativeLiveActivities } from './native-live-activities'

export function useLiveActivityHosts(): void {
  const [ids, setIds] = useState<string[]>([])
  useAllHostClients(ids, { closeUnusedOnRelease: true })
  useEffect(() => {
    const bridge = nativeLiveActivities
    if (!bridge) {
      return
    }
    let disposed = false
    let revision = 0
    const refresh = (): void => {
      const current = ++revision
      void Promise.all([
        loadLiveActivityPreferences(),
        loadHostCatalog(),
        pendingLiveActivityRetirementHosts(),
        bridge.authorization()
      ])
        .then(([preferences, catalog, pending, authorized]) => {
          if (!disposed && current === revision) {
            setIds(
              catalog
                .filter((host) => (preferences.enabled && authorized) || pending.includes(host.id))
                .map((host) => host.id)
            )
          }
        })
        .catch(() => undefined)
    }
    const unsubscribe = subscribeLiveActivityPreferences(refresh)
    const state = AppState.addEventListener('change', (value) => {
      if (value === 'active') {
        refresh()
      }
    })
    refresh()
    return () => {
      disposed = true
      unsubscribe()
      state.remove()
    }
  }, [])
}
