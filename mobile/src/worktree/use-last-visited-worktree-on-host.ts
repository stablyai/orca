import { useEffect, useState } from 'react'
import { readMirroredKeyOrStore, subscribeMirroredKey } from '../storage/mirrored-storage-keys'
import { LAST_VISITED_WORKTREE_STORAGE_KEY } from './last-visited-worktree-repo'
import type { LastVisitedWorktreeOnHost } from './host-list-highlight'
import {
  readLastVisitedWorktreeOnHost,
  subscribeLastVisitedWorktree
} from './last-visited-worktree-by-host'

// Track stored and locally noted visits; other pages reach a web page’s load-time copy only on reload.
// Null until history loads or when this host has no visit.
export function useLastVisitedWorktreeOnHost(
  hostId: string | undefined
): LastVisitedWorktreeOnHost | null {
  const [visited, setVisited] = useState<{
    hostId: string
    value: LastVisitedWorktreeOnHost | null
  } | null>(null)

  useEffect(() => {
    if (!hostId) {
      return
    }
    let stale = false
    let noted = false
    const take = (value: LastVisitedWorktreeOnHost) => {
      noted = true
      setVisited({ hostId, value })
    }
    const unsubscribeNotes = subscribeLastVisitedWorktree((visitedHostId, value) => {
      if (visitedHostId === hostId) {
        take(value)
      }
    })
    const unsubscribeStore = subscribeMirroredKey(LAST_VISITED_WORKTREE_STORAGE_KEY, (raw) => {
      // A write naming no visit here (another host's, in an older shape) leaves this one standing.
      const value = readLastVisitedWorktreeOnHost(raw, hostId)
      if (value) {
        take(value)
      }
    })
    void readMirroredKeyOrStore(LAST_VISITED_WORKTREE_STORAGE_KEY)
      .then((raw) => {
        // A visit noted while the read was open is newer than anything it returns.
        if (!stale && !noted) {
          setVisited({ hostId, value: readLastVisitedWorktreeOnHost(raw, hostId) })
        }
      })
      .catch(() => {})
    return () => {
      stale = true
      unsubscribeNotes()
      unsubscribeStore()
    }
  }, [hostId])

  return visited && visited.hostId === hostId ? visited.value : null
}
