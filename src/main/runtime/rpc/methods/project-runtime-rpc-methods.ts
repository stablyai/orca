import { z } from 'zod'
import { coerceProjectExecutionHostId } from '../../../../shared/execution-host'
import { defineMethod, type RpcMethod } from '../core'
import { OptionalString, requiredString } from '../schemas'
import { projectRepoResultVisibilityForClient } from '../repo-visibility-projection'

const INVALID_HOST_ID_MESSAGE =
  'Invalid host ID. Use local, ssh:<targetId>, or runtime:<environmentId> ' +
  '(bare ids from `orca environment list` are accepted as runtime:<id>).'

function requiredProjectHostId() {
  return requiredString('Missing host ID').transform((value, ctx) => {
    const hostId = coerceProjectExecutionHostId(value)
    if (!hostId) {
      ctx.addIssue({ code: 'custom', message: INVALID_HOST_ID_MESSAGE })
      return z.NEVER
    }
    return hostId
  })
}

const ProjectProviderIdentity = z.object({
  provider: z.literal('github'),
  owner: requiredString('Missing project owner'),
  repo: requiredString('Missing project repository'),
  host: OptionalString
})

const ProjectHostSetupExistingFolder = z.object({
  projectId: requiredString('Missing project ID'),
  projectProviderIdentity: ProjectProviderIdentity.optional(),
  hostId: requiredProjectHostId(),
  path: requiredString('Missing project path'),
  kind: z.enum(['git', 'folder']).optional(),
  displayName: OptionalString,
  setupMethod: z.enum(['imported-existing-folder', 'cloned']).optional()
})

const ProjectHostSetupClone = z.object({
  projectId: requiredString('Missing project ID'),
  projectProviderIdentity: ProjectProviderIdentity.optional(),
  hostId: requiredProjectHostId(),
  url: requiredString('Missing clone URL'),
  destination: requiredString('Missing clone destination'),
  displayName: OptionalString
})

const LocalWindowsRuntimePreference = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('inherit-global') }),
  z.object({ kind: z.literal('windows-host') }),
  z.object({ kind: z.literal('wsl'), distro: requiredString('Missing WSL distro') })
])

const ProjectUpdate = z.object({
  projectId: requiredString('Missing project ID'),
  updates: z.object({
    localWindowsRuntimePreference: LocalWindowsRuntimePreference.optional()
  })
})

const ProjectHostSetupCreate = z.object({
  projectId: requiredString('Missing project ID'),
  hostId: requiredProjectHostId(),
  setupId: OptionalString,
  path: OptionalString,
  kind: z.enum(['git', 'folder']).optional(),
  displayName: OptionalString,
  worktreeBasePath: OptionalString,
  gitUsername: OptionalString,
  setupState: z.enum(['ready', 'not-set-up', 'setting-up', 'error', 'unsupported']).optional(),
  setupMethod: z.enum(['imported-existing-folder', 'cloned', 'provisioned']).optional()
})

const ProjectHostSetupUpdate = z.object({
  setupId: requiredString('Missing setup ID'),
  updates: z.object({
    displayName: OptionalString,
    path: OptionalString,
    worktreeBasePath: OptionalString,
    setupState: z.enum(['ready', 'not-set-up', 'setting-up', 'error', 'unsupported']).optional(),
    setupMethod: z
      .enum(['legacy-repo', 'imported-existing-folder', 'cloned', 'provisioned'])
      .optional(),
    gitUsername: OptionalString,
    kind: z.enum(['git', 'folder']).optional()
  })
})

const ProjectHostSetupDelete = z.object({
  setupId: requiredString('Missing setup ID')
})

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
