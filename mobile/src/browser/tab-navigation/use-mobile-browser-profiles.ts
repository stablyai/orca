import { useEffect, useState } from 'react'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import { browserProfileListRead } from './mobile-session-browser-operations'

export type MobileBrowserProfile = { id: string; label: string }

/** The host's browser profiles while a sheet that names them is open; empty on older hosts. */
export function useMobileBrowserProfiles(
  client: RpcClient | null,
  enabled: boolean
): readonly MobileBrowserProfile[] {
  const [profiles, setProfiles] = useState<readonly MobileBrowserProfile[]>([])
  useEffect(() => {
    if (!client || !enabled) {
      return
    }
    let current = true
    void browserProfileListRead
      .request(client, null, { timeoutMs: 10_000 })
      .then((reply) => {
        const verdict = browserProfileListRead.interpret(reply)
        if (current) {
          setProfiles(verdict.accepted ? verdict.value : [])
        }
      })
      .catch(() => {})
    return () => {
      current = false
    }
  }, [client, enabled])
  return profiles
}
