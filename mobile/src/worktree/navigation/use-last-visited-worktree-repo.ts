import { useEffect, useState } from 'react'
import AsyncStorage from '@react-native-async-storage/async-storage'
import {
  LAST_VISITED_WORKTREE_STORAGE_KEY,
  readLastVisitedWorktreeRepoId
} from './last-visited-worktree-repo'

export function useLastVisitedWorktreeRepoId(
  hostId: string | undefined,
  enabled: boolean
): { loaded: boolean; repoId: string | null } {
  const [lastVisitedRepoId, setLastVisitedRepoId] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    if (!enabled || !hostId) {
      setLastVisitedRepoId(null)
      setLoaded(enabled)
      return
    }
    let stale = false
    setLoaded(false)
    void AsyncStorage.getItem(LAST_VISITED_WORKTREE_STORAGE_KEY)
      .then((raw) => {
        if (stale) {
          return
        }
        setLastVisitedRepoId(readLastVisitedWorktreeRepoId(raw, hostId))
        setLoaded(true)
      })
      .catch(() => {
        if (!stale) {
          setLastVisitedRepoId(null)
          setLoaded(true)
        }
      })

    return () => {
      stale = true
    }
  }, [enabled, hostId])

  return { loaded, repoId: lastVisitedRepoId }
}
