import { useMemo, useState } from 'react'
import { Keyboard } from 'react-native'

import type { ExecutionHostId } from '../../../../../src/shared/execution-host/execution-host'
import { useReachableServerClients } from '../../../worktree/execution-hosts/use-reachable-server-clients'
import { withServerHosts } from '../../../worktree/execution-hosts/server-workspaces'
import { NewWorktreeModal } from './NewWorktreeModal'
import type { NewWorktreeModalProps } from '../forms/new-worktree-modal-types'

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
  const [kind, setKind] = useState(modalProps.creationKind ?? 'worktree')
  const [opening, setOpening] = useState({ visible, epoch: 0 })
  if (opening.visible !== visible) {
    setOpening({ visible, epoch: visible ? opening.epoch + 1 : opening.epoch })
  }
  // Why the feed, not the list's server rows: the list stops refreshing behind the sheet.
  const { servers, serverClients } = useReachableServerClients(client, hostCapabilities, visible)
  const serverLabelById = useMemo(
    () => withServerHosts(hostLabelById, servers ?? [], (host) => host.label),
    [hostLabelById, servers]
  )

  return (
    <NewWorktreeModal
      key={`${modalProps.hostId ?? ''}:${opening.epoch}`}
      {...modalProps}
      creationKind={kind}
      onCreationKindChange={
        modalProps.folderLaunch
          ? undefined
          : (next) => {
              Keyboard.dismiss()
              setKind(next)
            }
      }
      visible={visible}
      client={client}
      serverClients={serverClients}
      hostLabelById={serverLabelById}
    />
  )
}
