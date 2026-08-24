import { useEffect, useState } from 'react'
import type { SshTargetSummary } from '../../../src/shared/ssh-types'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcSuccess } from '../transport/types'

const EMPTY_SSH_TARGET_LABELS: ReadonlyMap<string, string> = new Map()

export async function readMobileSshTargetLabels(
  client: RpcClient
): Promise<ReadonlyMap<string, string>> {
  try {
    const response = await client.sendRequest('ssh.listTargetSummaries')
    if (!response.ok) {
      return EMPTY_SSH_TARGET_LABELS
    }
    const { targets } = (response as RpcSuccess).result as { targets?: SshTargetSummary[] }
    return new Map(
      (targets ?? [])
        .map(({ id, label }) => [id.trim(), label.trim()] as const)
        .filter(([id, label]) => id.length > 0 && label.length > 0)
    )
  } catch {
    return EMPTY_SSH_TARGET_LABELS
  }
}

export function useMobileSshTargetLabels(
  client: RpcClient | null,
  enabled: boolean
): ReadonlyMap<string, string> {
  const [loaded, setLoaded] = useState<{
    client: RpcClient
    labels: ReadonlyMap<string, string>
  } | null>(null)

  useEffect(() => {
    if (!client || !enabled) {
      return
    }
    let stale = false
    void readMobileSshTargetLabels(client).then((nextLabels) => {
      if (!stale) {
        setLoaded({ client, labels: nextLabels })
      }
    })
    return () => {
      stale = true
    }
  }, [client, enabled])

  return enabled && loaded?.client === client ? loaded.labels : EMPTY_SSH_TARGET_LABELS
}
