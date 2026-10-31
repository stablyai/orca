import { useCallback } from 'react'
import { useLocalSearchParams } from 'expo-router'
import { useWorkspaceRouteHandoff } from '../navigation/workspace-route-handoff'
import { firstParam } from '../navigation/route-param-reader'
import { useWorkspaceClient } from '../transport/use-workspace-client'
import { useHostProtocolGates } from '../components/host-protocol-gates-context'
import { getWorktreeLabel } from '../session/worktree-label'
import { resolveMobileAgentLaunchAvailability } from '../session/mobile-agent-launch-availability'
import type { MobileGitChangedFile } from './git-compare-reply-schema'
import { orderMobileCommitFiles } from './mobile-commit-files'
import { buildMobileReviewFileRoute, readCommitRouteSha } from './mobile-review-route'
import { MobileCommitDetailScreen } from './MobileCommitDetailScreen'
import { useMobileCommitDetail } from './use-mobile-commit-detail'
import { useMobileCommitDetailActions } from './use-mobile-commit-detail-actions'
import { useMobileCommitFiles } from './use-mobile-commit-files'

// Keep the screen importable by the page: native route modules mount the shell.
export function MobileCommitDetailRouteScreen() {
  const params = useLocalSearchParams<{
    hostId?: string | string[]
    worktreeId?: string | string[]
    name?: string | string[]
    sha?: string | string[]
  }>()
  const hostId = firstParam(params.hostId)
  const worktreeId = firstParam(params.worktreeId)
  const name = firstParam(params.name)
  const commitId = readCommitRouteSha(firstParam(params.sha)) ?? ''
  const router = useWorkspaceRouteHandoff()
  const { client, state: connState } = useWorkspaceClient(hostId)
  const { hostCapabilities, statusPending, statusReadable } = useHostProtocolGates()
  const files = useMobileCommitFiles({ client, connState, worktreeId, commitId })
  const detail = useMobileCommitDetail({ client, connState, hostId, worktreeId, commitId })
  const actions = useMobileCommitDetailActions({
    client,
    connState,
    hostCapabilities,
    worktreeId,
    workspaceLabel: getWorktreeLabel(name, worktreeId),
    commitId,
    detail
  })

  const openFile = useCallback(
    (file: MobileGitChangedFile) =>
      router.push(
        buildMobileReviewFileRoute({
          hostId,
          worktreeId,
          worktreeName: name,
          filePath: file.path,
          area: 'commit',
          commitId
        })
      ),
    [commitId, hostId, name, router, worktreeId]
  )
  const reviewChanges = useCallback(() => {
    const first = orderMobileCommitFiles(files.files ?? [])[0]
    if (first) {
      openFile(first)
    }
  }, [files.files, openFile])

  return (
    <MobileCommitDetailScreen
      commitId={commitId}
      detail={detail}
      files={files}
      connected={client !== null && connState === 'connected'}
      notice={actions.notice}
      launch={actions.launch}
      launchAvailability={resolveMobileAgentLaunchAvailability({
        hostCapabilities,
        statusPending,
        statusReadable
      })}
      explaining={actions.explaining}
      onBack={() => router.back()}
      onOpenFile={openFile}
      onReviewChanges={reviewChanges}
      onCopyMessage={actions.copyMessage}
      onCopySha={actions.copySha}
      onOpenRemote={actions.openRemote}
      onExplain={actions.explain}
    />
  )
}
