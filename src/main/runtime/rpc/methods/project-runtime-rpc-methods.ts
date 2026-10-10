import { defineMethod } from '../core'
import { projectRepoResultVisibilityForClient } from '../repo-visibility-projection'
import {
  ProjectHostSetupClone,
  ProjectHostSetupCreate,
  ProjectHostSetupDelete,
  ProjectHostSetupExistingFolder,
  ProjectHostSetupUpdate,
  ProjectUpdate
} from '../../../../shared/rpc-contract/project-runtime-params'

export const PROJECT_RUNTIME_METHODS = [
  defineMethod({
    name: 'project.list',
    permission: 'workspace',
    params: null,
    handler: (_params, { runtime }) => {
      runtime.enrichMissingRepoGitRemoteIdentities?.()
      return { projects: runtime.listProjects() }
    }
  }),
  defineMethod({
    name: 'project.update',
    permission: 'workspace',
    params: ProjectUpdate,
    handler: (params, { runtime }) => ({
      project: runtime.updateProject(params.projectId, params.updates)
    })
  }),
  defineMethod({
    name: 'projectHostSetup.list',
    permission: 'workspace',
    params: null,
    handler: (_params, { runtime }) => {
      runtime.enrichMissingRepoGitRemoteIdentities?.()
      return { setups: runtime.listProjectHostSetups() }
    }
  }),
  defineMethod({
    name: 'projectHostSetup.create',
    permission: 'workspace',
    params: ProjectHostSetupCreate,
    handler: (params, { runtime }) => ({
      result: runtime.createProjectHostSetup(params)
    })
  }),
  defineMethod({
    name: 'projectHostSetup.setupExistingFolder',
    permission: 'workspace',
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
    permission: 'workspace',
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
    permission: 'workspace',
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
    permission: 'workspace',
    params: ProjectHostSetupDelete,
    handler: (params, context) => ({
      result: projectRepoResultVisibilityForClient(
        context.runtime.deleteProjectHostSetup(params),
        context
      )
    })
  })
]
