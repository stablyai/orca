import {
  addIssueCommentBySlug,
  deleteIssueCommentBySlug,
  updateIssueCommentBySlug
} from '../../../github/project-view/issue-comment-mutations'
import {
  clearProjectItemFieldValue,
  updateProjectItemFieldValue
} from '../../../github/project-view/project-field-mutations'
import { getProjectViewTable } from '../../../github/project-view/project-view-table'
import { getWorkItemDetailsBySlug } from '../../../github/project-view/work-item-details'
import { listAccessibleProjects } from '../../../github/project-view/project-view-discovery'
import {
  listAssignableUsersBySlug,
  listIssueTypesBySlug,
  listLabelsBySlug
} from '../../../github/project-view/repository-field-options'
import { listProjectViews } from '../../../github/project-view/project-view-listing'
import { resolveProjectRef } from '../../../github/project-view/project-view-reference'
import { updateIssueBySlug } from '../../../github/project-view/mutations'
import { updateIssueTypeBySlug } from '../../../github/project-view/issue-type-mutation'
import { updatePullRequestBySlug } from '../../../github/project-view/pull-request-mutation'
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
} from '../../../../shared/github/projects/project-request-types'

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
