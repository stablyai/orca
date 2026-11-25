import { defineMethod } from '../../core'
import { projectRepoResultVisibilityForClient } from '../../workspace-client-views/repo-visibility-projection'
import {
  ProjectHostSetupClone,
  ProjectHostSetupCreate,
  ProjectHostSetupDelete,
  ProjectHostSetupExistingFolder,
  ProjectHostSetupUpdate,
  ProjectUpdate
} from '../../../../../shared/rpc-contract/projects/project-runtime-params'

export const PROJECT_RUNTIME_METHODS = [
  defineMethod({
    name: 'project.list',
    permission: 'workspace',
    share: 'not-shared',
    params: null,
    handler: (_params, { runtime }) => {
      runtime.enrichMissingRepoGitRemoteIdentities?.()
      return { projects: runtime.listProjects() }
    }
  }),
  defineMethod({
    name: 'project.update',
    permission: 'workspace',
    share: 'not-shared',
    params: ProjectUpdate,
    handler: (params, { runtime }) => ({
      project: runtime.updateProject(params.projectId, params.updates)
    })
  }),
  defineMethod({
    name: 'projectHostSetup.list',
    permission: 'workspace',
    share: 'not-shared',
    params: null,
    handler: (_params, { runtime }) => {
      runtime.enrichMissingRepoGitRemoteIdentities?.()
      return { setups: runtime.listVisibleProjectHostSetups() }
    }
  }),
  defineMethod({
    name: 'projectHostSetup.create',
    permission: 'workspace',
    share: 'not-shared',
    params: ProjectHostSetupCreate,
    handler: (params, { runtime }) => ({
      result: runtime.createProjectHostSetup(params)
    })
  }),
  defineMethod({
    name: 'projectHostSetup.setupExistingFolder',
    permission: 'workspace',
    share: 'not-shared',
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
    share: 'not-shared',
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
    share: 'not-shared',
    params: ProjectHostSetupUpdate,
    handler: async (params, context) => ({
      result: projectRepoResultVisibilityForClient(
        await context.runtime.updateProjectHostSetup(params),
        context
      )
    })
  }),
  defineMethod({
    name: 'projectHostSetup.delete',
    permission: 'workspace',
    share: 'not-shared',
    params: ProjectHostSetupDelete,
    handler: (params, context) => ({
      result: projectRepoResultVisibilityForClient(
        context.runtime.deleteProjectHostSetup(params),
        context
      )
    })
  })
]
