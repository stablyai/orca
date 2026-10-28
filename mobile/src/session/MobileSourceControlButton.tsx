import { memo } from 'react'
import { WORKTREE_REVIEW_STATUS_RUNTIME_CAPABILITY } from '../../../src/shared/worktree-runtime-capabilities'
import { useRouteCapability } from '../transport/use-workspace-client'
import type { RpcClient } from '../transport/rpc-client'
import { MobileReviewStatusIconButton } from './MobileReviewStatusIconButton'
import { useMobileWorkspaceReviewStatus } from './use-mobile-workspace-review-status'

type Props = {
  client: RpcClient | null
  worktreeId: string
  enabled: boolean
  active: boolean
  onPress: () => void
}

export const MobileSourceControlButton = memo(function MobileSourceControlButton({
  client,
  worktreeId,
  enabled,
  active,
  onPress
}: Props) {
  const supported = useRouteCapability(WORKTREE_REVIEW_STATUS_RUNTIME_CAPABILITY)
  const presentation = useMobileWorkspaceReviewStatus({ client, worktreeId, enabled, supported })
  return (
    <MobileReviewStatusIconButton presentation={presentation} active={active} onPress={onPress} />
  )
})
