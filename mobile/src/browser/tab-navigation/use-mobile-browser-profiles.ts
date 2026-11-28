import { useEffect, useState } from 'react'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import { browserProfileListRead } from './mobile-session-browser-operations'

export type MobileBrowserProfile = { id: string; label: string }

const NO_PROFILES: readonly MobileBrowserProfile[] = []

/** The host's browser profiles while a sheet that names them is open; empty on older hosts. */
export function useMobileBrowserProfiles(
  client: RpcClient | null,
  enabled: boolean
): readonly MobileBrowserProfile[] {
  const [read, setRead] = useState<{
    client: RpcClient
    profiles: readonly MobileBrowserProfile[]
  } | null>(null)
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
          setRead(verdict.accepted ? { client, profiles: verdict.value } : null)
        }
      })
      .catch(() => {
        // Clear stale profiles on timeout or error so a deleted profile is not sent.
        if (current) {
          setRead(null)
        }
      })
    return () => {
      current = false
    }
  }, [client, enabled])
  return client && read?.client === client ? read.profiles : NO_PROFILES
}
