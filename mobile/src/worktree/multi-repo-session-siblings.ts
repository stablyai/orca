import { folderWorkspaceKey } from '../../../src/shared/workspace-scope'
import type { MultiRepoSiblingList } from './multi-repo-workspace-reply-schema'

export type MultiRepoSessionSiblings = {
  workspaceName: string
  /** Null while the session shows the workspace folder itself. */
  currentMemberName: string | null
  destinations: { key: string; label: string; worktreeId: string; current: boolean }[]
}

export function resolveMultiRepoSessionSiblings(
  list: MultiRepoSiblingList,
  worktreeId: string
): MultiRepoSessionSiblings | null {
  for (const workspace of list.folderWorkspaces) {
    const members = workspace.multiRepo?.members
    if (!members) {
      continue
    }
    const rootId = folderWorkspaceKey(workspace.id)
    const current = members.find((member) => member.worktreeId === worktreeId)
    if (worktreeId !== rootId && !current) {
      continue
    }
    return {
      workspaceName: workspace.name,
      currentMemberName: current?.dirName ?? null,
      destinations: [
        { key: rootId, label: 'All', worktreeId: rootId, current: worktreeId === rootId },
        ...members.flatMap((member) =>
          member.state === 'ready' && member.worktreeId
            ? [
                {
                  key: member.memberId,
                  label: member.dirName,
                  worktreeId: member.worktreeId,
                  current: member.worktreeId === worktreeId
                }
              ]
            : []
        )
      ]
    }
  }
  return null
}
