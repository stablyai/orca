import type { FolderWorkspace } from '../../shared/folder-workspace-types'
import type {
  MultiRepoDeleteInspection,
  MultiRepoDeleteResult
} from '../../shared/multi-repo-workspace'
import type { TuiAgent } from '../../shared/tui-agent'

type MemberArgs = { folderWorkspaceId: string; memberId: string }

export type MultiRepoWorkspacesApi = {
  create: (args: {
    name: string
    members: { repoId: string; branchName?: string; baseRef?: string }[]
    clientMutationId?: string
    createdWithAgent?: TuiAgent
  }) => Promise<{ folderWorkspace: FolderWorkspace }>
  retryMember: (args: MemberArgs) => Promise<{ folderWorkspace: FolderWorkspace }>
  removeMember: (args: MemberArgs) => Promise<{ folderWorkspace: FolderWorkspace }>
  detachMember: (args: MemberArgs) => Promise<{ folderWorkspace: FolderWorkspace }>
  attachMember: (args: MemberArgs) => Promise<{ folderWorkspace: FolderWorkspace }>
  inspectDelete: (args: { folderWorkspaceId: string }) => Promise<MultiRepoDeleteInspection>
  delete: (args: {
    folderWorkspaceId: string
    forceMemberIds?: string[]
    allowFailedArchiveHookMemberIds?: string[]
    runHooks?: boolean
  }) => Promise<MultiRepoDeleteResult>
}
