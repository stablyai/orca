import { useCallback, useEffect, useRef, useState } from 'react'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { persistMirrored } from '../storage/mirrored-storage-keys'

const remembered = new Map<string, boolean>()

export function useHostActivityView(hostId: string | undefined) {
  const key = `orca:activityView:${encodeURIComponent(hostId ?? '')}`
  const [selection, setSelection] = useState({ key, active: remembered.get(key) ?? false })
  const writes = useRef(0)
  useEffect(() => {
    let current = true
    const revision = writes.current
    void AsyncStorage.getItem(key)
      .then((value) => {
        if (current && revision === writes.current) {
          const active = value === 'activity'
          remembered.set(key, active)
          setSelection({ key, active })
        }
      })
      .catch(() => {})
    return () => {
      current = false
    }
  }, [key])
  const active = selection.key === key ? selection.active : (remembered.get(key) ?? false)
  const toggle = useCallback(() => {
    writes.current += 1
    remembered.set(key, !active)
    setSelection({ key, active: !active })
    void persistMirrored(key, !active ? 'activity' : 'workspaces').catch(() => {})
  }, [key, active])
  return { active, toggle }
}
