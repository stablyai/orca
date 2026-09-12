import { defineMethod } from '../core'
import { PROJECT_RUNTIME_METHODS } from './project-runtime-rpc-methods'
import { FOLDER_WORKSPACE_METHODS } from './folder-workspace'
import { RepoSelector } from './github-repo-target-schemas'
import {
  projectRepoResultVisibilityForClient,
  projectRepoVisibilityForClient
} from '../repo-visibility-projection'
import {
  ProjectGroupCreate,
  ProjectGroupImportNested,
  ProjectGroupMoveProject,
  ProjectGroupScanNested,
  ProjectGroupSelector,
  ProjectGroupUpdate,
  RepoClone,
  RepoCreate,
  RepoIssueCommandWrite,
  RepoPath,
  RepoReorder,
  RepoSearchRefs,
  RepoSetBaseRef,
  RepoSparsePresetSave,
  RepoUpdate
} from '../../../../shared/rpc-contract/repo-params'

export const REPO_METHODS = [
  defineMethod({
    name: 'repo.list',
    params: null,
    handler: (_params, context) => {
      context.runtime.enrichMissingRepoGitRemoteIdentities?.()
      return {
        repos: context.runtime
          .listRepos()
          .map((repo) => projectRepoVisibilityForClient(repo, context))
      }
    }
  }),
  ...PROJECT_RUNTIME_METHODS,
  defineMethod({
    name: 'projectGroup.list',
    params: null,
    handler: (_params, { runtime }) => ({ groups: runtime.listProjectGroups() })
  }),
  defineMethod({
    name: 'projectGroup.create',
    params: ProjectGroupCreate,
    handler: async (params, { runtime }) => ({
      group: await runtime.createProjectGroup(params)
    })
  }),
  defineMethod({
    name: 'projectGroup.update',
    params: ProjectGroupUpdate,
    handler: async (params, { runtime }) => ({
      group: await runtime.updateProjectGroup(params.groupId, params.updates)
    })
  }),
  defineMethod({
    name: 'projectGroup.delete',
    params: ProjectGroupSelector,
    handler: async (params, { runtime }) => runtime.deleteProjectGroup(params.groupId)
  }),
  defineMethod({
    name: 'projectGroup.moveProject',
    params: ProjectGroupMoveProject,
    handler: async (params, context) => ({
      repo: projectRepoVisibilityForClient(
        await context.runtime.moveProjectToGroup(params.repo, params.groupId ?? null, params.order),
        context
      )
    })
  }),
  ...FOLDER_WORKSPACE_METHODS,
  defineMethod({
    name: 'projectGroup.scanNested',
    params: ProjectGroupScanNested,
    handler: async (params, { runtime }) => runtime.scanNestedRepos(params.path)
  }),
  defineMethod({
    name: 'projectGroup.importNested',
    params: ProjectGroupImportNested,
    handler: async (params, { runtime }) => runtime.importNestedRepos(params)
  }),
  defineMethod({
    name: 'repo.sparsePresets',
    params: RepoSelector,
    handler: async (params, { runtime }) => ({
      presets: await runtime.listSparsePresets(params.repo)
    })
  }),
  defineMethod({
    name: 'repo.saveSparsePreset',
    params: RepoSparsePresetSave,
    handler: async (params, { runtime }) => ({
      preset: await runtime.saveSparsePreset(params.repo, {
        ...(params.id ? { id: params.id } : {}),
        name: params.name,
        directories: params.directories
      })
    })
  }),
  defineMethod({
    name: 'repo.add',
    params: RepoPath,
    handler: async (params, context) => ({
      repo: projectRepoVisibilityForClient(
        await context.runtime.addRepo(params.path, params.kind, undefined, params.displayName),
        context
      )
    })
  }),
  defineMethod({
    name: 'repo.create',
    params: RepoCreate,
    handler: async (params, context) =>
      projectRepoResultVisibilityForClient(
        await context.runtime.createRepo(params.parentPath, params.name, params.kind),
        context
      )
  }),
  defineMethod({
    name: 'repo.gitAvailable',
    params: null,
    handler: async (_params, { runtime }) => ({ available: await runtime.isGitAvailable() })
  }),
  defineMethod({
    name: 'repo.clone',
    params: RepoClone,
    handler: async (params, context) => ({
      repo: projectRepoVisibilityForClient(
        await context.runtime.cloneRepo(params.url, params.destination),
        context
      )
    })
  }),
  defineMethod({
    name: 'repo.show',
    params: RepoSelector,
    handler: async (params, context) => ({
      repo: projectRepoVisibilityForClient(await context.runtime.showRepo(params.repo), context)
    })
  }),
  defineMethod({
    name: 'repo.update',
    params: RepoUpdate,
    handler: async (params, context) => ({
      repo: projectRepoVisibilityForClient(
        await context.runtime.updateRepo(
          params.repo,
          params.updates as Parameters<typeof context.runtime.updateRepo>[1]
        ),
        context
      )
    })
  }),
  defineMethod({
    name: 'repo.rm',
    params: RepoSelector,
    handler: async (params, { runtime }) => runtime.removeProject(params.repo)
  }),
  defineMethod({
    name: 'repo.reorder',
    params: RepoReorder,
    handler: async (params, { runtime }) => runtime.reorderRepos(params.orderedIds)
  }),
  defineMethod({
    name: 'repo.setBaseRef',
    params: RepoSetBaseRef,
    handler: async (params, context) => ({
      repo: projectRepoVisibilityForClient(
        await context.runtime.setRepoBaseRef(params.repo, params.ref),
        context
      )
    })
  }),
  defineMethod({
    name: 'repo.baseRefDefault',
    params: RepoSelector,
    handler: async (params, { runtime }) => runtime.getRepoBaseRefDefault(params.repo)
  }),
  defineMethod({
    name: 'repo.searchRefs',
    params: RepoSearchRefs,
    handler: async (params, { runtime }) =>
      runtime.searchRepoRefs(params.repo, params.query, params.limit)
  }),
  defineMethod({
    name: 'repo.hooks',
    params: RepoSelector,
    handler: async (params, { runtime }) => runtime.getRepoHooks(params.repo)
  }),
  defineMethod({
    name: 'repo.hooksCheck',
    params: RepoSelector,
    handler: async (params, { runtime }) => runtime.checkRepoHooks(params.repo)
  }),
  defineMethod({
    name: 'repo.setupScriptImports',
    params: RepoSelector,
    handler: async (params, { runtime }) => runtime.inspectRepoSetupScriptImports(params.repo)
  }),
  defineMethod({
    name: 'repo.issueCommandRead',
    params: RepoSelector,
    handler: async (params, { runtime }) => runtime.readRepoIssueCommand(params.repo)
  }),
  defineMethod({
    name: 'repo.issueCommandWrite',
    params: RepoIssueCommandWrite,
    handler: async (params, { runtime }) =>
      runtime.writeRepoIssueCommand(params.repo, params.content)
  })
]
