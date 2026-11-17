import { useFocusEffect } from 'expo-router'
import { useCallback, useState } from 'react'
import type { CloudEnrollment } from './cloud-device-identity'
import { cloudWorkspaceHostIds } from './cloud-workspace-links'

const EMPTY: ReadonlySet<string> = new Set()

/** Paired hosts that are cloud workspace VMs; re-read on focus since attach happens on other screens. */
export function useCloudHostIds(
  enrollment: CloudEnrollment | null | undefined
): ReadonlySet<string> {
  const [ids, setIds] = useState<ReadonlySet<string>>(EMPTY)
  useFocusEffect(
    useCallback(() => {
      let live = true
      void cloudWorkspaceHostIds()
        .then((next) => live && setIds((current) => (sameSet(current, next) ? current : next)))
        .catch(() => undefined)
      return () => {
        live = false
      }
      // Re-read when enrollment changes (disconnect forgets every cloud host).
    }, [enrollment?.deviceSessionId])
  )
  return ids
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && [...a].every((id) => b.has(id))
}
