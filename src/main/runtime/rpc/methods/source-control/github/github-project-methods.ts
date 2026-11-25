import { defineMethod } from '../../../core'
import { SlugRepo } from '../../../../../../shared/rpc-contract/github/github-repo-target-params'
import {
  ClearProjectItemField,
  GithubProjectListAccessibleParams,
  ProjectItemField,
  ProjectRef,
  ProjectViewTable,
  ProjectViews,
  ProjectWorkItemDetailsBySlug,
  SlugAssignableUsers,
  SlugIssueComment,
  SlugIssueCommentDelete,
  SlugIssueCommentEdit,
  SlugIssueTypeUpdate,
  SlugIssueUpdate,
  SlugPullRequestUpdate
} from '../../../../../../shared/rpc-contract/github/github-project-params'

export const GITHUB_PROJECT_METHODS = [
  defineMethod({
    name: 'github.project.listAccessible',
    permission: 'workspace',
    share: 'not-shared',
    params: GithubProjectListAccessibleParams,
    handler: async (params, { runtime }) => runtime.listGitHubProjects(params)
  }),
  defineMethod({
    name: 'github.project.listLabelsBySlug',
    permission: 'workspace',
    share: 'not-shared',
    params: SlugRepo,
    handler: async (params, { runtime }) => runtime.listGitHubLabelsBySlug(params)
  }),
  defineMethod({
    name: 'github.project.listAssignableUsersBySlug',
    permission: 'workspace',
    share: 'not-shared',
    params: SlugAssignableUsers,
    handler: async (params, { runtime }) => runtime.listGitHubAssignableUsersBySlug(params)
  }),
  defineMethod({
    name: 'github.project.listIssueTypesBySlug',
    permission: 'workspace',
    share: 'not-shared',
    params: SlugRepo,
    handler: async (params, { runtime }) => runtime.listGitHubIssueTypesBySlug(params)
  }),
  defineMethod({
    name: 'github.project.resolveRef',
    permission: 'workspace',
    share: 'not-shared',
    params: ProjectRef,
    handler: async (params, { runtime }) => runtime.resolveGitHubProjectRef(params)
  }),
  defineMethod({
    name: 'github.project.listViews',
    permission: 'workspace',
    share: 'not-shared',
    params: ProjectViews,
    handler: async (params, { runtime }) => runtime.listGitHubProjectViews(params)
  }),
  defineMethod({
    name: 'github.project.viewTable',
    permission: 'workspace',
    share: 'not-shared',
    params: ProjectViewTable,
    handler: async (params, { runtime }) => runtime.getGitHubProjectViewTable(params)
  }),
  defineMethod({
    name: 'github.project.workItemDetailsBySlug',
    permission: 'workspace',
    share: 'not-shared',
    params: ProjectWorkItemDetailsBySlug,
    handler: async (params, { runtime }) => runtime.getGitHubProjectWorkItemDetailsBySlug(params)
  }),
  defineMethod({
    name: 'github.project.updateItemField',
    permission: 'workspace',
    share: 'not-shared',
    params: ProjectItemField,
    handler: async (params, { runtime }) => runtime.updateGitHubProjectItemField(params)
  }),
  defineMethod({
    name: 'github.project.clearItemField',
    permission: 'workspace',
    share: 'not-shared',
    params: ClearProjectItemField,
    handler: async (params, { runtime }) => runtime.clearGitHubProjectItemField(params)
  }),
  defineMethod({
    name: 'github.project.updateIssueBySlug',
    permission: 'workspace',
    share: 'not-shared',
    params: SlugIssueUpdate,
    handler: async (params, { runtime }) => runtime.updateGitHubIssueBySlug(params)
  }),
  defineMethod({
    name: 'github.project.updatePullRequestBySlug',
    permission: 'workspace',
    share: 'not-shared',
    params: SlugPullRequestUpdate,
    handler: async (params, { runtime }) => runtime.updateGitHubPullRequestBySlug(params)
  }),
  defineMethod({
    name: 'github.project.updateIssueTypeBySlug',
    permission: 'workspace',
    share: 'not-shared',
    params: SlugIssueTypeUpdate,
    handler: async (params, { runtime }) => runtime.updateGitHubIssueTypeBySlug(params)
  }),
  defineMethod({
    name: 'github.project.addIssueCommentBySlug',
    permission: 'workspace',
    share: 'not-shared',
    params: SlugIssueComment,
    handler: async (params, { runtime }) => runtime.addGitHubIssueCommentBySlug(params)
  }),
  defineMethod({
    name: 'github.project.updateIssueCommentBySlug',
    permission: 'workspace',
    share: 'not-shared',
    params: SlugIssueCommentEdit,
    handler: async (params, { runtime }) => runtime.updateGitHubIssueCommentBySlug(params)
  }),
  defineMethod({
    name: 'github.project.deleteIssueCommentBySlug',
    permission: 'workspace',
    share: 'not-shared',
    params: SlugIssueCommentDelete,
    handler: async (params, { runtime }) => runtime.deleteGitHubIssueCommentBySlug(params)
  })
]
