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
    params: GithubProjectListAccessibleParams,
    handler: async (params, { runtime }) => runtime.listGitHubProjects(params)
  }),
  defineMethod({
    name: 'github.project.listLabelsBySlug',
    params: SlugRepo,
    handler: async (params, { runtime }) => runtime.listGitHubLabelsBySlug(params)
  }),
  defineMethod({
    name: 'github.project.listAssignableUsersBySlug',
    params: SlugAssignableUsers,
    handler: async (params, { runtime }) => runtime.listGitHubAssignableUsersBySlug(params)
  }),
  defineMethod({
    name: 'github.project.listIssueTypesBySlug',
    params: SlugRepo,
    handler: async (params, { runtime }) => runtime.listGitHubIssueTypesBySlug(params)
  }),
  defineMethod({
    name: 'github.project.resolveRef',
    params: ProjectRef,
    handler: async (params, { runtime }) => runtime.resolveGitHubProjectRef(params)
  }),
  defineMethod({
    name: 'github.project.listViews',
    params: ProjectViews,
    handler: async (params, { runtime }) => runtime.listGitHubProjectViews(params)
  }),
  defineMethod({
    name: 'github.project.viewTable',
    params: ProjectViewTable,
    handler: async (params, { runtime }) => runtime.getGitHubProjectViewTable(params)
  }),
  defineMethod({
    name: 'github.project.workItemDetailsBySlug',
    params: ProjectWorkItemDetailsBySlug,
    handler: async (params, { runtime }) => runtime.getGitHubProjectWorkItemDetailsBySlug(params)
  }),
  defineMethod({
    name: 'github.project.updateItemField',
    params: ProjectItemField,
    handler: async (params, { runtime }) => runtime.updateGitHubProjectItemField(params)
  }),
  defineMethod({
    name: 'github.project.clearItemField',
    params: ClearProjectItemField,
    handler: async (params, { runtime }) => runtime.clearGitHubProjectItemField(params)
  }),
  defineMethod({
    name: 'github.project.updateIssueBySlug',
    params: SlugIssueUpdate,
    handler: async (params, { runtime }) => runtime.updateGitHubIssueBySlug(params)
  }),
  defineMethod({
    name: 'github.project.updatePullRequestBySlug',
    params: SlugPullRequestUpdate,
    handler: async (params, { runtime }) => runtime.updateGitHubPullRequestBySlug(params)
  }),
  defineMethod({
    name: 'github.project.updateIssueTypeBySlug',
    params: SlugIssueTypeUpdate,
    handler: async (params, { runtime }) => runtime.updateGitHubIssueTypeBySlug(params)
  }),
  defineMethod({
    name: 'github.project.addIssueCommentBySlug',
    params: SlugIssueComment,
    handler: async (params, { runtime }) => runtime.addGitHubIssueCommentBySlug(params)
  }),
  defineMethod({
    name: 'github.project.updateIssueCommentBySlug',
    params: SlugIssueCommentEdit,
    handler: async (params, { runtime }) => runtime.updateGitHubIssueCommentBySlug(params)
  }),
  defineMethod({
    name: 'github.project.deleteIssueCommentBySlug',
    params: SlugIssueCommentDelete,
    handler: async (params, { runtime }) => runtime.deleteGitHubIssueCommentBySlug(params)
  })
]
