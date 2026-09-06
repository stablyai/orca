import type { MobileWebTaskLinearDetailResult } from '../../../src/shared/mobile-web/task-detail-contract'
import type { MobileWebTaskTargetAuthority } from './mobile-web-task-target-authority'

export function pageLinearIssue(
  issue: MobileWebTaskLinearDetailResult['issue'],
  authority: MobileWebTaskTargetAuthority
): MobileWebTaskLinearDetailResult['issue'] {
  return {
    ...issue,
    targetId: authority.registerLinear({
      issueId: issue.id,
      ...(issue.workspaceId ? { workspaceId: issue.workspaceId } : {})
    }),
    subIssues: issue.subIssues?.map((child) => ({
      ...child,
      targetId: authority.registerLinear({
        issueId: child.id,
        ...(issue.workspaceId ? { workspaceId: issue.workspaceId } : {})
      })
    }))
  }
}
