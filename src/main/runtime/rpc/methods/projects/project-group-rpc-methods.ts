import { defineMethod } from '../../core'
import { projectRepoVisibilityForClient } from '../../repo-visibility-projection'
import {
  ProjectGroupCreate,
  ProjectGroupImportNested,
  ProjectGroupMoveProject,
  ProjectGroupScanNested,
  ProjectGroupSelector,
  ProjectGroupUpdate,
  ProjectGroupUpdateMany
} from '../../../../../shared/rpc-contract/repo-params'

export const PROJECT_GROUP_METHODS = [
  defineMethod({
    name: 'projectGroup.list',
    permission: 'workspace',
    params: null,
    handler: (_params, { runtime }) => ({ groups: runtime.listVisibleProjectGroups() })
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
    name: 'projectGroup.updateMany',
    permission: 'workspace',
    params: ProjectGroupUpdateMany,
    handler: async (params, { runtime }) => ({
      groups: await runtime.updateProjectGroups(params.mutations)
    })
  }),
  defineMethod({
    name: 'projectGroup.moveProject',
    permission: 'workspace',
    params: ProjectGroupMoveProject,
    handler: async (params, context) => ({
      repo: projectRepoVisibilityForClient(
        await context.runtime.moveProjectToGroup(
          params.repo,
          params.groupId ?? null,
          params.order,
          params.connectionId
        ),
        context
      )
    })
  }),
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
  })
]
