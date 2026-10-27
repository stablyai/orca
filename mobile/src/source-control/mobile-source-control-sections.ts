import { useEffect, useMemo, useState } from 'react'
import { DEFAULT_SOURCE_CONTROL_GROUP_ORDER } from '../../../src/shared/source-control-group-order'
import type { SourceControlGroupOrder } from '../../../src/shared/ui-chrome-types'
import { sourceControlGroupOrderRead } from '../transport/settings-read-operations'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState } from '../transport/types'
import { buildMobileSourceControlSections, type MobileGitStatusEntry } from './mobile-git-status'

// Desktop's Source Control group order, read once per connection; mobile has no settings stream.
function useMobileSourceControlGroupOrder(
  client: RpcClient | null,
  connState: ConnectionState
): SourceControlGroupOrder {
  // Keyed by client so a new host never shows the previous host's order while its read is in flight.
  const [read, setRead] = useState<{ client: RpcClient; order: SourceControlGroupOrder } | null>(
    null
  )
  useEffect(() => {
    if (!client || connState !== 'connected') {
      return
    }
    let stale = false
    void sourceControlGroupOrderRead
      .request(client)
      .then((response) => {
        const reply = sourceControlGroupOrderRead.interpret(response)
        if (!stale && reply.accepted) {
          setRead({ client, order: reply.value })
        }
      })
      .catch(() => {
        // Keep the default order when the host is unreachable.
      })
    return () => {
      stale = true
    }
  }, [client, connState])
  return read && read.client === client ? read.order : DEFAULT_SOURCE_CONTROL_GROUP_ORDER
}

export function useMobileSourceControlSections<TEntry extends MobileGitStatusEntry>(
  client: RpcClient | null,
  connState: ConnectionState,
  entries: readonly TEntry[]
) {
  const groupOrder = useMobileSourceControlGroupOrder(client, connState)
  return useMemo(() => buildMobileSourceControlSections(entries, groupOrder), [entries, groupOrder])
}
