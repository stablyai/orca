import { useEffect, useState } from 'react'
import { readMirroredKeyOrStore, subscribeMirroredKey } from '../storage/mirrored-storage-keys'
import { LAST_VISITED_WORKTREE_STORAGE_KEY } from './last-visited-worktree-repo'
import type { LastVisitedWorktreeOnHost } from './host-list-highlight'
import {
  readLastVisitedWorktreeOnHost,
  subscribeLastVisitedWorktree
} from './last-visited-worktree-by-host'

/**
 * The workspace this phone last opened on `hostId`: stored, then each visit noted in this context
 * (a list tap) or written through this context's store (in the app, a session page's write).
 * A web page's store is its load-time copy, so a visit another page makes reaches it on reload.
 * Null until the stored visit is read, and when this phone has opened nothing there.
 */
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

  // Keyed by host so a switch to another host never shows the last one's visit.
  return visited && visited.hostId === hostId ? visited.value : null
}
