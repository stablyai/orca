import { ipcMain } from 'electron'
import type {
  AttachToParentArgs,
  AttachToParentResult,
  NotifyWorktreeCreatedArgs,
  NotifyWorktreeCreatedResult,
  LineageCommitProjectArgs,
  LineageCommitProjectResult,
  LineageGitStatusArgs,
  LineageGitStatusPayload,
  LineageGetFileDiffArgs,
  LineageGetFileDiffResult,
  LineageGetMembersArgs,
  LineageGetMembersResult,
  LineageAddManualLinkArgs,
  LineageAddManualLinkResult,
  LineageRemoveManualLinkArgs,
  LineageRemoveManualLinkResult,
  LineageTestPatternArgs,
  LineageTestPatternResult
} from '../../shared/fleet-lineage-types'
import {
  attachWorkspaceToParent,
  notifyWorktreeCreated,
  type LineageStoreContract
} from '../lineage/workspace-lineage-service'
import { commitLineageProject, getLineageFileDiff } from '../lineage/lineage-git-status-service'
import {
  handleLineageMembersRequest,
  handleLineageStatusRequest
} from '../lineage/lineage-ipc-requests'
import { createLineagePatternScanCache } from '../lineage/lineage-pattern-scan-cache'
import { addLineageManualLink, removeLineageManualLink } from '../lineage/lineage-manual-links'
import { testLineagePattern } from '../lineage/lineage-pattern-test'
import { lookupLineagePullRequestHeadBranch } from '../lineage/lineage-pr-head-branch'
import { listRepoWorktrees } from '../lineage/lineage-name-pattern-discovery'

export function registerLineageIpcHandlers(store: LineageStoreContract): void {
  const patternScanCache = createLineagePatternScanCache()
  ipcMain.removeHandler('workspace:attach-to-parent')
  ipcMain.handle(
    'workspace:attach-to-parent',
    async (_event, args: AttachToParentArgs): Promise<AttachToParentResult> => {
      return attachWorkspaceToParent(store, args)
    }
  )

  ipcMain.removeHandler('workspace:notify-worktree-created')
  ipcMain.handle(
    'workspace:notify-worktree-created',
    async (_event, args: NotifyWorktreeCreatedArgs): Promise<NotifyWorktreeCreatedResult> => {
      return notifyWorktreeCreated(store, args)
    }
  )

  ipcMain.removeHandler('git:lineage-get-status')
  ipcMain.handle(
    'git:lineage-get-status',
    async (_event, args: LineageGitStatusArgs): Promise<LineageGitStatusPayload> =>
      handleLineageStatusRequest(store, args, { patternScanCache })
  )

  ipcMain.removeHandler('git:lineage-commit-project')
  ipcMain.handle(
    'git:lineage-commit-project',
    async (_event, args: LineageCommitProjectArgs): Promise<LineageCommitProjectResult> => {
      return commitLineageProject(store, args)
    }
  )

  ipcMain.removeHandler('git:lineage-get-file-diff')
  ipcMain.handle(
    'git:lineage-get-file-diff',
    async (_event, args: LineageGetFileDiffArgs): Promise<LineageGetFileDiffResult> => {
      return getLineageFileDiff(args, {
        resolveWorktreePath: (id: string) => store.getWorktree?.(id)?.path
      })
    }
  )

  ipcMain.removeHandler('lineage:get-members')
  ipcMain.handle(
    'lineage:get-members',
    async (_event, args: LineageGetMembersArgs): Promise<LineageGetMembersResult> =>
      handleLineageMembersRequest(store, args, { patternScanCache })
  )

  ipcMain.removeHandler('lineage:add-manual-link')
  ipcMain.handle(
    'lineage:add-manual-link',
    async (_event, args: LineageAddManualLinkArgs): Promise<LineageAddManualLinkResult> => {
      patternScanCache.clear()
      return addLineageManualLink(store, args, {
        lookupPullRequestHeadBranch: lookupLineagePullRequestHeadBranch,
        listRepoWorktrees: (repo) => listRepoWorktrees(repo, { patternScanCache })
      })
    }
  )

  ipcMain.removeHandler('lineage:remove-manual-link')
  ipcMain.handle(
    'lineage:remove-manual-link',
    async (_event, args: LineageRemoveManualLinkArgs): Promise<LineageRemoveManualLinkResult> => {
      patternScanCache.clear()
      return removeLineageManualLink(store, args)
    }
  )

  ipcMain.removeHandler('lineage:test-pattern')
  ipcMain.handle(
    'lineage:test-pattern',
    async (_event, args: LineageTestPatternArgs): Promise<LineageTestPatternResult> =>
      testLineagePattern(args)
  )
}
