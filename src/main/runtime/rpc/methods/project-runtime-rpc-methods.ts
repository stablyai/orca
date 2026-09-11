import { defineMethod, type RpcMethod } from '../core'
import { projectRepoResultVisibilityForClient } from '../repo-visibility-projection'
import {
  ProjectHostSetupClone,
  ProjectHostSetupCreate,
  ProjectHostSetupDelete,
  ProjectHostSetupExistingFolder,
  ProjectHostSetupUpdate,
  ProjectUpdate
} from '../../../../shared/rpc-contract/project-runtime-params'

export const PROJECT_RUNTIME_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'project.list',
    params: null,
    handler: (_params, { runtime }) => {
      runtime.enrichMissingRepoGitRemoteIdentities?.()
      return { projects: runtime.listProjects() }
    }
  }),
  defineMethod({
    name: 'project.update',
    params: ProjectUpdate,
    handler: (params, { runtime }) => ({
      project: runtime.updateProject(params.projectId, params.updates)
    })
  }),
  defineMethod({
    name: 'projectHostSetup.list',
    params: null,
    handler: (_params, { runtime }) => {
      runtime.enrichMissingRepoGitRemoteIdentities?.()
      return { setups: runtime.listProjectHostSetups() }
    }
  }),
  defineMethod({
    name: 'projectHostSetup.create',
    params: ProjectHostSetupCreate,
    handler: (params, { runtime }) => ({
      result: runtime.createProjectHostSetup(params)
    })
  }),
  defineMethod({
    name: 'projectHostSetup.setupExistingFolder',
    params: ProjectHostSetupExistingFolder,
    handler: async (params, context) => ({
      result: projectRepoResultVisibilityForClient(
        await context.runtime.setupProjectExistingFolder(params),
        context
      )
    })
  }),
  defineMethod({
    name: 'projectHostSetup.clone',
    params: ProjectHostSetupClone,
    handler: async (params, context) => ({
      result: projectRepoResultVisibilityForClient(
        await context.runtime.setupProjectClone(params),
        context
      )
    })
  }),
  defineMethod({
    name: 'projectHostSetup.update',
    params: ProjectHostSetupUpdate,
    handler: (params, context) => ({
      result: projectRepoResultVisibilityForClient(
        context.runtime.updateProjectHostSetup(params),
        context
      )
    })
  }),
  defineMethod({
    name: 'projectHostSetup.delete',
    params: ProjectHostSetupDelete,
    handler: (params, context) => ({
      result: projectRepoResultVisibilityForClient(
        context.runtime.deleteProjectHostSetup(params),
        context
      )
    })
  })
]
