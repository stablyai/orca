import { defineMethod } from '../core'
import { SlugRepo } from './github-repo-target-schemas'
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
} from '../../../../shared/rpc-contract/github-project-params'

export const GITHUB_PROJECT_METHODS = [
  defineMethod({
    name: 'github.project.listAccessible',
    permission: 'workspace',
    params: GithubProjectListAccessibleParams,
    handler: async (params, { runtime }) => runtime.listGitHubProjects(params)
  }),
  defineMethod({
    name: 'github.project.listLabelsBySlug',
    permission: 'workspace',
    params: SlugRepo,
    handler: async (params, { runtime }) => runtime.listGitHubLabelsBySlug(params)
  }),
  defineMethod({
    name: 'github.project.listAssignableUsersBySlug',
    permission: 'workspace',
    params: SlugAssignableUsers,
    handler: async (params, { runtime }) => runtime.listGitHubAssignableUsersBySlug(params)
  }),
  defineMethod({
    name: 'github.project.listIssueTypesBySlug',
    permission: 'workspace',
    params: SlugRepo,
    handler: async (params, { runtime }) => runtime.listGitHubIssueTypesBySlug(params)
  }),
  defineMethod({
    name: 'github.project.resolveRef',
    permission: 'workspace',
    params: ProjectRef,
    handler: async (params, { runtime }) => runtime.resolveGitHubProjectRef(params)
  }),
  defineMethod({
    name: 'github.project.listViews',
    permission: 'workspace',
    params: ProjectViews,
    handler: async (params, { runtime }) => runtime.listGitHubProjectViews(params)
  }),
  defineMethod({
    name: 'github.project.viewTable',
    permission: 'workspace',
    params: ProjectViewTable,
    handler: async (params, { runtime }) => runtime.getGitHubProjectViewTable(params)
  }),
  defineMethod({
    name: 'github.project.workItemDetailsBySlug',
    permission: 'workspace',
    params: ProjectWorkItemDetailsBySlug,
    handler: async (params, { runtime }) => runtime.getGitHubProjectWorkItemDetailsBySlug(params)
  }),
  defineMethod({
    name: 'github.project.updateItemField',
    permission: 'workspace',
    params: ProjectItemField,
    handler: async (params, { runtime }) => runtime.updateGitHubProjectItemField(params)
  }),
  defineMethod({
    name: 'github.project.clearItemField',
    permission: 'workspace',
    params: ClearProjectItemField,
    handler: async (params, { runtime }) => runtime.clearGitHubProjectItemField(params)
  }),
  defineMethod({
    name: 'github.project.updateIssueBySlug',
    permission: 'workspace',
    params: SlugIssueUpdate,
    handler: async (params, { runtime }) => runtime.updateGitHubIssueBySlug(params)
  }),
  defineMethod({
    name: 'github.project.updatePullRequestBySlug',
    permission: 'workspace',
    params: SlugPullRequestUpdate,
    handler: async (params, { runtime }) => runtime.updateGitHubPullRequestBySlug(params)
  }),
  defineMethod({
    name: 'github.project.updateIssueTypeBySlug',
    permission: 'workspace',
    params: SlugIssueTypeUpdate,
    handler: async (params, { runtime }) => runtime.updateGitHubIssueTypeBySlug(params)
  }),
  defineMethod({
    name: 'github.project.addIssueCommentBySlug',
    permission: 'workspace',
    params: SlugIssueComment,
    handler: async (params, { runtime }) => runtime.addGitHubIssueCommentBySlug(params)
  }),
  defineMethod({
    name: 'github.project.updateIssueCommentBySlug',
    permission: 'workspace',
    params: SlugIssueCommentEdit,
    handler: async (params, { runtime }) => runtime.updateGitHubIssueCommentBySlug(params)
  }),
  defineMethod({
    name: 'github.project.deleteIssueCommentBySlug',
    permission: 'workspace',
    params: SlugIssueCommentDelete,
    handler: async (params, { runtime }) => runtime.deleteGitHubIssueCommentBySlug(params)
  })
]
