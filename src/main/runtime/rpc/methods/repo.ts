import { defineMethod } from '../core'
import { PROJECT_RUNTIME_METHODS } from './project-runtime-rpc-methods'
import { FOLDER_WORKSPACE_METHODS } from './folder-workspace'
import {
  includesQualifiedSearchRefs,
  projectRepoSearchRefsForClient
} from './repo-search-ref-projection'
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
    permission: 'workspace',
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
    permission: 'workspace',
    params: null,
    handler: (_params, { runtime }) => ({ groups: runtime.listProjectGroups() })
  }),
  defineMethod({
    name: 'projectGroup.create',
    permission: 'workspace',
    params: ProjectGroupCreate,
    handler: async (params, { runtime }) => ({
      group: await runtime.createProjectGroup(params)
    })
  }),
  defineMethod({
    name: 'projectGroup.update',
    permission: 'workspace',
    params: ProjectGroupUpdate,
    handler: async (params, { runtime }) => ({
      group: await runtime.updateProjectGroup(params.groupId, params.updates)
    })
  }),
  defineMethod({
    name: 'projectGroup.delete',
    permission: 'workspace',
    params: ProjectGroupSelector,
    handler: async (params, { runtime }) => runtime.deleteProjectGroup(params.groupId)
  }),
  defineMethod({
    name: 'projectGroup.moveProject',
    permission: 'workspace',
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
    permission: 'workspace',
    params: ProjectGroupScanNested,
    handler: async (params, { runtime }) => runtime.scanNestedRepos(params.path)
  }),
  defineMethod({
    name: 'projectGroup.importNested',
    permission: 'workspace',
    params: ProjectGroupImportNested,
    handler: async (params, { runtime }) => runtime.importNestedRepos(params)
  }),
  defineMethod({
    name: 'repo.sparsePresets',
    permission: 'workspace',
    params: RepoSelector,
    handler: async (params, { runtime }) => ({
      presets: await runtime.listSparsePresets(params.repo)
    })
  }),
  defineMethod({
    name: 'repo.saveSparsePreset',
    permission: 'workspace',
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
    permission: 'workspace',
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
    permission: 'workspace',
    params: RepoCreate,
    handler: async (params, context) =>
      projectRepoResultVisibilityForClient(
        await context.runtime.createRepo(params.parentPath, params.name, params.kind),
        context
      )
  }),
  defineMethod({
    name: 'repo.gitAvailable',
    permission: 'workspace',
    params: null,
    handler: async (_params, { runtime }) => ({ available: await runtime.isGitAvailable() })
  }),
  defineMethod({
    name: 'repo.clone',
    permission: 'workspace',
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
    permission: 'workspace',
    params: RepoSelector,
    handler: async (params, context) => ({
      repo: projectRepoVisibilityForClient(await context.runtime.showRepo(params.repo), context)
    })
  }),
  defineMethod({
    name: 'repo.update',
    permission: 'workspace',
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
    permission: 'workspace',
    params: RepoSelector,
    handler: async (params, { runtime }) => runtime.removeProject(params.repo)
  }),
  defineMethod({
    name: 'repo.reorder',
    permission: 'workspace',
    params: RepoReorder,
    handler: async (params, { runtime }) => runtime.reorderRepos(params.orderedIds)
  }),
  defineMethod({
    name: 'repo.setBaseRef',
    permission: 'workspace',
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
    permission: 'workspace',
    params: RepoSelector,
    handler: async (params, { runtime }) => runtime.getRepoBaseRefDefault(params.repo)
  }),
  defineMethod({
    name: 'repo.searchRefs',
    permission: 'workspace',
    params: RepoSearchRefs,
    handler: async (params, { runtime, clientCapabilities }) =>
      projectRepoSearchRefsForClient(
        await runtime.searchRepoRefs(
          params.repo,
          params.query,
          params.limit,
          includesQualifiedSearchRefs(clientCapabilities)
        ),
        clientCapabilities
      )
  }),
  defineMethod({
    name: 'repo.hooks',
    permission: 'workspace',
    params: RepoSelector,
    handler: async (params, { runtime }) => runtime.getRepoHooks(params.repo)
  }),
  defineMethod({
    name: 'repo.hooksCheck',
    permission: 'workspace',
    params: RepoSelector,
    handler: async (params, { runtime }) => runtime.checkRepoHooks(params.repo)
  }),
  defineMethod({
    name: 'repo.setupScriptImports',
    permission: 'workspace',
    params: RepoSelector,
    handler: async (params, { runtime }) => runtime.inspectRepoSetupScriptImports(params.repo)
  }),
  defineMethod({
    name: 'repo.issueCommandRead',
    permission: 'workspace',
    params: RepoSelector,
    handler: async (params, { runtime }) => runtime.readRepoIssueCommand(params.repo)
  }),
  defineMethod({
    name: 'repo.issueCommandWrite',
    permission: 'workspace',
    params: RepoIssueCommandWrite,
    handler: async (params, { runtime }) =>
      runtime.writeRepoIssueCommand(params.repo, params.content)
  })
]
