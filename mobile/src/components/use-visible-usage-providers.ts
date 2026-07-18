import { useCallback, useState } from 'react'
import { useFocusEffect } from 'expo-router'
import { loadVisibleUsageProvidersSettled } from '../storage/preferences'
import { DEFAULT_VISIBLE_USAGE_PROVIDERS, type UsageProviderKey } from './account-usage-state'

export function useVisibleUsageProviders(): Set<UsageProviderKey> {
  const [visible, setVisible] = useState<Set<UsageProviderKey>>(
    () => new Set(DEFAULT_VISIBLE_USAGE_PROVIDERS)
  )

  // Why: settings routes are pushed over existing screens, so visibility must
  // reload on focus rather than only when a home/accounts screen first mounts.
  useFocusEffect(
    useCallback(() => {
      let active = true
      void loadVisibleUsageProvidersSettled().then((stored) => {
        if (active) {
          setVisible(stored)
        }
      })
      return () => {
        active = false
      }
    }, [])
  )

  return visible
}
