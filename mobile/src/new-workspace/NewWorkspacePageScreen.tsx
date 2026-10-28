import { useMemo } from 'react'
import { useLocalSearchParams } from 'expo-router'
import { NewWorktreeModalController } from '../components/NewWorktreeModalController'
import { hostNewWorktreeSessionRoute } from '../host-new-worktree-session-route'
import { useHostLabelById } from './use-host-label-by-id'
import { useHostWorktreeRows } from './use-host-worktree-rows'
import { useRouteHandoff } from '../navigation/route-handoff'
import { firstParam } from '../navigation/route-param-reader'
import { workspaceRouteHref } from '../navigation/workspace-execution-host'
import { openExternalLink } from '../platform/external-link'
import { useHostClient } from '../transport/host-client-hooks'
import { useHostProtocolGates } from '../components/host-protocol-gates-context'

// Use a transparent drawer page; close returns to its opener and creation replaces it with the new workspace session.
export function NewWorkspacePageScreen() {
  const params = useLocalSearchParams<{ hostId?: string | string[] }>()
  const hostId = firstParam(params.hostId)
  const router = useRouteHandoff()
  const { client, state: connState } = useHostClient(hostId)
  const { hostCapabilities } = useHostProtocolGates()
  const connected = connState === 'connected'
  const worktrees = useHostWorktreeRows(client, connected, hostId)
  const hostLabelById = useHostLabelById(client, connected)
  const worktreePaths = useMemo(() => worktrees.map((worktree) => worktree.path), [worktrees])

  return (
    <NewWorktreeModalController
      visible
      client={client}
      hostCapabilities={hostCapabilities}
      hostId={hostId}
      hostLabelById={hostLabelById}
      existingWorktreePaths={worktreePaths}
      existingWorktrees={worktrees}
      openExternalUrl={openExternalLink}
      onCreated={(worktreeId, name, warning, executionHost) =>
        router.replace(
          workspaceRouteHref(
            hostNewWorktreeSessionRoute(hostId, worktreeId, name, warning),
            executionHost
          )
        )
      }
      onClose={() => router.back()}
    />
  )
}
