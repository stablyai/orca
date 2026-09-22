import { ipcMain } from 'electron'
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
  UpdatePullRequestBySlugArgs
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

export function registerGitHubProjectViewHandlers(): void {
  ipcMain.handle('gh:listAccessibleProjects', (_event, args?: ListAccessibleProjectsArgs) =>
    listAccessibleProjects(args)
  )
  ipcMain.handle('gh:resolveProjectRef', (_event, args: ResolveProjectRefArgs) =>
    resolveProjectRef(args)
  )
  ipcMain.handle('gh:listProjectViews', (_event, args: ListProjectViewsArgs) =>
    listProjectViews(args)
  )
  ipcMain.handle('gh:getProjectViewTable', (_event, args: GetProjectViewTableArgs) =>
    getProjectViewTable(args)
  )
  ipcMain.handle(
    'gh:projectWorkItemDetailsBySlug',
    (_event, args: ProjectWorkItemDetailsBySlugArgs) => getWorkItemDetailsBySlug(args)
  )
  ipcMain.handle('gh:updateProjectItemField', (_event, args: UpdateProjectItemFieldArgs) =>
    updateProjectItemFieldValue(args)
  )
  ipcMain.handle('gh:clearProjectItemField', (_event, args: ClearProjectItemFieldArgs) =>
    clearProjectItemFieldValue(args)
  )
  ipcMain.handle('gh:updateIssueBySlug', (_event, args: UpdateIssueBySlugArgs) =>
    updateIssueBySlug(args)
  )
  ipcMain.handle('gh:updatePullRequestBySlug', (_event, args: UpdatePullRequestBySlugArgs) =>
    updatePullRequestBySlug(args)
  )
  ipcMain.handle('gh:addIssueCommentBySlug', (_event, args: AddIssueCommentBySlugArgs) =>
    addIssueCommentBySlug(args)
  )
  ipcMain.handle('gh:updateIssueCommentBySlug', (_event, args: UpdateIssueCommentBySlugArgs) =>
    updateIssueCommentBySlug(args)
  )
  ipcMain.handle('gh:deleteIssueCommentBySlug', (_event, args: DeleteIssueCommentBySlugArgs) =>
    deleteIssueCommentBySlug(args)
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
    updateIssueTypeBySlug(args)
  )
}
