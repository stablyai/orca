import { useEffect, useState } from 'react'
import type { ExecutionHostId } from '../../../src/shared/execution-host'
import { readHostSshTargetLabels } from '../host-screen/host-ssh-target-labels-read'
import type { RpcClient } from '../transport/rpc-client'

const NO_HOST_LABELS: ReadonlyMap<ExecutionHostId, string> = new Map()

/** The names the desktop's SSH hosts show under, as the host screen reads them: one read. */
export function useHostLabelById(
  client: RpcClient | null,
  connected: boolean
): ReadonlyMap<ExecutionHostId, string> {
  const [labels, setLabels] = useState(NO_HOST_LABELS)

  useEffect(() => {
    if (!client || !connected) {
      return
    }
    let live = true
    readHostSshTargetLabels(client)
      .then(({ hostLabelById }) => {
        if (live) {
          setLabels(hostLabelById)
        }
      })
      // Unread labels fall back to host ids, as the host screen's do before its first read.
      .catch(() => {})
    return () => {
      live = false
    }
  }, [client, connected])

  return labels
}
