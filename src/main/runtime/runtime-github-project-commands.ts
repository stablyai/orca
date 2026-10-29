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
  constructor(private readonly assertUnscopedAccess: () => void = () => {}) {}
  listGitHubProjects(args?: ListAccessibleProjectsArgs) {
    this.assertUnscopedAccess()
    return listAccessibleProjects(args)
  }
  listGitHubLabelsBySlug(args: ListLabelsBySlugArgs) {
    this.assertUnscopedAccess()
    return listLabelsBySlug(args)
  }
  listGitHubAssignableUsersBySlug(args: ListAssignableUsersBySlugArgs) {
    this.assertUnscopedAccess()
    return listAssignableUsersBySlug(args)
  }
  listGitHubIssueTypesBySlug(args: ListIssueTypesBySlugArgs) {
    this.assertUnscopedAccess()
    return listIssueTypesBySlug(args)
  }
  resolveGitHubProjectRef(args: ResolveProjectRefArgs) {
    this.assertUnscopedAccess()
    return resolveProjectRef(args)
  }
  listGitHubProjectViews(args: ListProjectViewsArgs) {
    this.assertUnscopedAccess()
    return listProjectViews(args)
  }
  getGitHubProjectViewTable(args: GetProjectViewTableArgs) {
    this.assertUnscopedAccess()
    return getProjectViewTable(args)
  }
  getGitHubProjectWorkItemDetailsBySlug(args: ProjectWorkItemDetailsBySlugArgs) {
    this.assertUnscopedAccess()
    return getWorkItemDetailsBySlug(args)
  }
  updateGitHubProjectItemField(args: UpdateProjectItemFieldArgs) {
    this.assertUnscopedAccess()
    return updateProjectItemFieldValue(args)
  }
  clearGitHubProjectItemField(args: ClearProjectItemFieldArgs) {
    this.assertUnscopedAccess()
    return clearProjectItemFieldValue(args)
  }
  updateGitHubIssueBySlug(args: UpdateIssueBySlugArgs) {
    this.assertUnscopedAccess()
    return updateIssueBySlug(args)
  }
  updateGitHubPullRequestBySlug(args: UpdatePullRequestBySlugArgs) {
    this.assertUnscopedAccess()
    return updatePullRequestBySlug(args)
  }
  updateGitHubIssueTypeBySlug(args: UpdateIssueTypeBySlugArgs) {
    this.assertUnscopedAccess()
    return updateIssueTypeBySlug(args)
  }
  addGitHubIssueCommentBySlug(args: AddIssueCommentBySlugArgs) {
    this.assertUnscopedAccess()
    return addIssueCommentBySlug(args)
  }
  updateGitHubIssueCommentBySlug(args: UpdateIssueCommentBySlugArgs) {
    this.assertUnscopedAccess()
    return updateIssueCommentBySlug(args)
  }
  deleteGitHubIssueCommentBySlug(args: DeleteIssueCommentBySlugArgs) {
    this.assertUnscopedAccess()
    return deleteIssueCommentBySlug(args)
  }
}
