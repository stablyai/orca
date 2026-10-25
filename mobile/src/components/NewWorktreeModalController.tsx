import { useMemo } from 'react'

import type { ExecutionHostId } from '../../../src/shared/execution-host'
import { useReachableServerClients } from '../worktree/use-reachable-server-clients'
import { withServerHosts } from '../worktree/server-workspaces'
import { NewWorktreeModal } from './NewWorktreeModal'
import type { NewWorktreeModalProps } from './new-worktree-modal-types'

type Props = Omit<NewWorktreeModalProps, 'serverClients' | 'hostLabelById'> & {
  /** The desktop's capabilities, which say whether its servers are reachable through it. */
  hostCapabilities: readonly string[]
  /** The desktop's own host names; the sheet adds its servers' from the feed. */
  hostLabelById: ReadonlyMap<ExecutionHostId, string>
}

export function NewWorktreeModalController({
  visible,
  client,
  hostCapabilities,
  hostLabelById,
  ...modalProps
}: Props) {
  // Why the feed, not the list's server rows: the list stops refreshing behind the sheet.
  const { servers, serverClients } = useReachableServerClients(client, hostCapabilities, visible)
  const serverLabelById = useMemo(
    () => withServerHosts(hostLabelById, servers ?? [], (host) => host.label),
    [hostLabelById, servers]
  )

  return (
    <NewWorktreeModal
      {...modalProps}
      visible={visible}
      client={client}
      serverClients={serverClients}
      hostLabelById={serverLabelById}
    />
  )
}
