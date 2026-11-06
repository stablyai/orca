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
} from '../../../../shared/github/project-request-types'

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
