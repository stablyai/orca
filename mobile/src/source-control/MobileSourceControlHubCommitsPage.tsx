import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { MobileCommitsScreen } from './MobileCommitsScreen'
import {
  buildMobileBranchRemoteAction,
  type MobileSourceControlReviewInputs
} from './mobile-source-control-primary-action'
import type { MobileSourceControlState } from './use-mobile-source-control-state'

type Props = {
  state: MobileSourceControlState
  hostId: string
  worktreeId: string
  embedded: boolean
  review: MobileSourceControlReviewInputs
  statusHead: string | null
  onBack: () => void
}

/** The Commits screen pushed over the hub, with the branch's Push from the shared decision. */
export function MobileSourceControlHubCommitsPage({
  state,
  hostId,
  worktreeId,
  embedded,
  review,
  statusHead,
  onBack
}: Props) {
  const t = useMobileTranslation()
  const { primaryActionArgs, status } = state
  const branchRemoteAction = useMemo(
    () => buildMobileBranchRemoteAction({ ...primaryActionArgs, review }),
    [primaryActionArgs, review, t]
  )
  // Pass primitives and a stable runner so commit-message keystrokes do not rerender the Commits list.
  const branchRemoteActionRef = useRef(branchRemoteAction)
  useEffect(() => {
    branchRemoteActionRef.current = branchRemoteAction
  }, [branchRemoteAction])
  const runBranchRemoteAction = useCallback(
    () => branchRemoteActionRef.current?.run() ?? Promise.resolve(),
    []
  )
  const upstream = status?.upstreamStatus
  return (
    <MobileCommitsScreen
      client={state.client}
      connState={state.connState}
      worktreeId={worktreeId}
      hostId={hostId}
      openDiffForFile={state.openDiffForFile}
      embedded={embedded}
      bottomInset={state.insets.bottom}
      refreshKey={`${statusHead ?? ''}:${upstream?.ahead ?? ''}:${upstream?.behind ?? ''}`}
      branchName={state.branchLabel}
      busyAction={state.busyAction}
      actionError={state.actionError}
      pushLabel={branchRemoteAction?.label}
      pushDisabled={branchRemoteAction?.disabled}
      pushBusy={branchRemoteAction?.loading}
      onPush={runBranchRemoteAction}
      onUpdateBranch={state.runActionSheetRebase}
      onBack={onBack}
    />
  )
}
