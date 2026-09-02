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

export class RuntimeGitHubProjectCommands {
  listGitHubProjects(args?: ListAccessibleProjectsArgs) {
    return listAccessibleProjects(args)
  }
  listGitHubLabelsBySlug(args: ListLabelsBySlugArgs) {
    return listLabelsBySlug(args)
  }
  listGitHubAssignableUsersBySlug(args: ListAssignableUsersBySlugArgs) {
    return listAssignableUsersBySlug(args)
  }
  listGitHubIssueTypesBySlug(args: ListIssueTypesBySlugArgs) {
    return listIssueTypesBySlug(args)
  }
  resolveGitHubProjectRef(args: ResolveProjectRefArgs) {
    return resolveProjectRef(args)
  }
  listGitHubProjectViews(args: ListProjectViewsArgs) {
    return listProjectViews(args)
  }
  getGitHubProjectViewTable(args: GetProjectViewTableArgs) {
    return getProjectViewTable(args)
  }
  getGitHubProjectWorkItemDetailsBySlug(args: ProjectWorkItemDetailsBySlugArgs) {
    return getWorkItemDetailsBySlug(args)
  }
  updateGitHubProjectItemField(args: UpdateProjectItemFieldArgs) {
    return updateProjectItemFieldValue(args)
  }
  clearGitHubProjectItemField(args: ClearProjectItemFieldArgs) {
    return clearProjectItemFieldValue(args)
  }
  updateGitHubIssueBySlug(args: UpdateIssueBySlugArgs) {
    return updateIssueBySlug(args)
  }
  updateGitHubPullRequestBySlug(args: UpdatePullRequestBySlugArgs) {
    return updatePullRequestBySlug(args)
  }
  updateGitHubIssueTypeBySlug(args: UpdateIssueTypeBySlugArgs) {
    return updateIssueTypeBySlug(args)
  }
  addGitHubIssueCommentBySlug(args: AddIssueCommentBySlugArgs) {
    return addIssueCommentBySlug(args)
  }
  updateGitHubIssueCommentBySlug(args: UpdateIssueCommentBySlugArgs) {
    return updateIssueCommentBySlug(args)
  }
  deleteGitHubIssueCommentBySlug(args: DeleteIssueCommentBySlugArgs) {
    return deleteIssueCommentBySlug(args)
  }
}
