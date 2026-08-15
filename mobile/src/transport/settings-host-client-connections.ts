import { useCallback, useState } from 'react'
import { useFocusEffect } from 'expo-router'
import { useAllHostClients } from './use-all-host-clients'

export function useFocusedSettingsHostClients(hostIds: string[]) {
  const [focused, setFocused] = useState(false)

  useFocusEffect(
    useCallback(() => {
      setFocused(true)
      return () => setFocused(false)
    }, [])
  )

  const clients = useAllHostClients(focused ? hostIds : [], {
    closeUnusedOnRelease: true
  })
  return { clients, focused }
}
