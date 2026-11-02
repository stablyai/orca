import { ipcMain } from 'electron'
import { runAsDefaultWslCliUserAct } from '../git/command-runner/default-wsl-cli-fallback'
import type {
  AddIssueCommentBySlugArgs,
  ClearProjectItemFieldArgs,
  DeleteIssueCommentBySlugArgs,
  GetProjectViewTableArgs,
  ListAccessibleProjectsArgs,
  ListAssignableUsersBySlugArgs,
  ListIssueTypesBySlugArgs,
  ListLabelsBySlugArgs,
  ListProjectViewsArgs,
  ProjectWorkItemDetailsBySlugArgs,
  ResolveProjectRefArgs,
  UpdateIssueBySlugArgs,
  UpdateIssueCommentBySlugArgs,
  UpdateIssueTypeBySlugArgs,
  UpdateProjectItemFieldArgs,
  UpdatePullRequestBySlugArgs,
  WakeWslDistroArg
} from '../../shared/github/project-request-types'
import {
  addIssueCommentBySlug,
  clearProjectItemFieldValue,
  deleteIssueCommentBySlug,
  getProjectViewTable,
  getWorkItemDetailsBySlug,
  listAccessibleProjects,
  listAssignableUsersBySlug,
  listIssueTypesBySlug,
  listLabelsBySlug,
  listProjectViews,
  resolveProjectRef,
  updateIssueBySlug,
  updateIssueCommentBySlug,
  updateIssueTypeBySlug,
  updateProjectItemFieldValue,
  updatePullRequestBySlug
} from '../github/project-view'

// Only a click (the renderer sets wakeWslDistro) may start the stopped distro gh lives in (E9); the
// same reads also run from mount effects on a restored page, which must stay gated.
function wakeOnClick<T>(args: WakeWslDistroArg | undefined, act: () => Promise<T>): Promise<T> {
  return args?.wakeWslDistro === true ? runAsDefaultWslCliUserAct(act) : act()
}

export function registerGitHubProjectViewHandlers(): void {
  ipcMain.handle('gh:listAccessibleProjects', (_event, args?: ListAccessibleProjectsArgs) =>
    wakeOnClick(args, () => listAccessibleProjects(args))
  )
  ipcMain.handle('gh:resolveProjectRef', (_event, args: ResolveProjectRefArgs) =>
    wakeOnClick(args, () => resolveProjectRef(args))
  )
  ipcMain.handle('gh:listProjectViews', (_event, args: ListProjectViewsArgs) =>
    wakeOnClick(args, () => listProjectViews(args))
  )
  ipcMain.handle('gh:getProjectViewTable', (_event, args: GetProjectViewTableArgs) =>
    getProjectViewTable(args)
  )
  ipcMain.handle(
    'gh:projectWorkItemDetailsBySlug',
    (_event, args: ProjectWorkItemDetailsBySlugArgs) =>
      wakeOnClick(args, () => getWorkItemDetailsBySlug(args))
  )
  ipcMain.handle('gh:updateProjectItemField', (_event, args: UpdateProjectItemFieldArgs) =>
    wakeOnClick(args, () => updateProjectItemFieldValue(args))
  )
  ipcMain.handle('gh:clearProjectItemField', (_event, args: ClearProjectItemFieldArgs) =>
    wakeOnClick(args, () => clearProjectItemFieldValue(args))
  )
  ipcMain.handle('gh:updateIssueBySlug', (_event, args: UpdateIssueBySlugArgs) =>
    wakeOnClick(args, () => updateIssueBySlug(args))
  )
  ipcMain.handle('gh:updatePullRequestBySlug', (_event, args: UpdatePullRequestBySlugArgs) =>
    wakeOnClick(args, () => updatePullRequestBySlug(args))
  )
  ipcMain.handle('gh:addIssueCommentBySlug', (_event, args: AddIssueCommentBySlugArgs) =>
    wakeOnClick(args, () => addIssueCommentBySlug(args))
  )
  ipcMain.handle('gh:updateIssueCommentBySlug', (_event, args: UpdateIssueCommentBySlugArgs) =>
    wakeOnClick(args, () => updateIssueCommentBySlug(args))
  )
  ipcMain.handle('gh:deleteIssueCommentBySlug', (_event, args: DeleteIssueCommentBySlugArgs) =>
    wakeOnClick(args, () => deleteIssueCommentBySlug(args))
  )
  ipcMain.handle('gh:listLabelsBySlug', (_event, args: ListLabelsBySlugArgs) =>
    listLabelsBySlug(args)
  )
  ipcMain.handle('gh:listAssignableUsersBySlug', (_event, args: ListAssignableUsersBySlugArgs) =>
    listAssignableUsersBySlug(args)
  )
  ipcMain.handle('gh:listIssueTypesBySlug', (_event, args: ListIssueTypesBySlugArgs) =>
    listIssueTypesBySlug(args)
  )
  ipcMain.handle('gh:updateIssueTypeBySlug', (_event, args: UpdateIssueTypeBySlugArgs) =>
    wakeOnClick(args, () => updateIssueTypeBySlug(args))
  )
}
