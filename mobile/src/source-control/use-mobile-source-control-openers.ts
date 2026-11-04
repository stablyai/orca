import { useCallback } from 'react'
import { useWorkspaceRouteHandoff } from '../navigation/workspace-route-handoff'
import { buildMobileReviewFileRoute, type MobileReviewRouteArea } from './mobile-review-route'

// A changed file in the worktree or on the branch, or a file in one commit (diffed against its parent).
export type MobileDiffFileTarget =
  | { kind: 'changes'; filePath: string; area: MobileReviewRouteArea; line?: number }
  | { kind: 'commit'; filePath: string; commitOid: string }

type Params = {
  hostId: string
  worktreeId: string
  name: string
}

// Every changed-file row opens the one diff screen through this entry point.
export function useMobileSourceControlOpeners({ hostId, worktreeId, name }: Params) {
  // Use the handoff seam: routes the embedded page cannot render belong to the native app.
  const router = useWorkspaceRouteHandoff()

  const openDiffForFile = useCallback(
    (target: MobileDiffFileTarget) => {
      router.push(
        buildMobileReviewFileRoute({
          hostId,
          worktreeId,
          worktreeName: name,
          filePath: target.filePath,
          ...(target.kind === 'changes' && target.line !== undefined ? { line: target.line } : {}),
          ...(target.kind === 'commit'
            ? { area: 'commit', commitOid: target.commitOid }
            : { area: target.area })
        })
      )
    },
    [hostId, name, router, worktreeId]
  )

  return { router, openDiffForFile }
}
