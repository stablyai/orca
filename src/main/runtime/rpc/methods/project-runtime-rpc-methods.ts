import { z } from 'zod'
import { normalizeExecutionHostId } from '../../../../shared/execution-host'
import { defineMethod, type RpcMethod } from '../core'
import { OptionalString, requiredString } from '../schemas'

const ProjectHostSetupExistingFolder = z.object({
  projectId: requiredString('Missing project ID'),
  hostId: requiredString('Missing host ID').transform((value, ctx) => {
    const hostId = normalizeExecutionHostId(value)
    if (!hostId) {
      ctx.addIssue({ code: 'custom', message: 'Invalid host ID' })
      return z.NEVER
    }
    return hostId
  }),
  path: requiredString('Missing project path'),
  kind: z.enum(['git', 'folder']).optional(),
  displayName: OptionalString,
  setupMethod: z.enum(['imported-existing-folder', 'cloned']).optional()
})

const ProjectHostSetupClone = z.object({
  projectId: requiredString('Missing project ID'),
  hostId: requiredString('Missing host ID').transform((value, ctx) => {
    const hostId = normalizeExecutionHostId(value)
    if (!hostId) {
      ctx.addIssue({ code: 'custom', message: 'Invalid host ID' })
      return z.NEVER
    }
    return hostId
  }),
  url: requiredString('Missing clone URL'),
  destination: requiredString('Missing clone destination'),
  displayName: OptionalString
})

const ProjectHostSetupCreate = z.object({
  projectId: requiredString('Missing project ID'),
  hostId: requiredString('Missing host ID').transform((value, ctx) => {
    const hostId = normalizeExecutionHostId(value)
    if (!hostId) {
      ctx.addIssue({ code: 'custom', message: 'Invalid host ID' })
      return z.NEVER
    }
    return hostId
  }),
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
    handler: (_params, { runtime }) => ({ projects: runtime.listProjects() })
  }),
  defineMethod({
    name: 'projectHostSetup.list',
    params: null,
    handler: (_params, { runtime }) => ({ setups: runtime.listProjectHostSetups() })
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
    handler: async (params, { runtime }) => ({
      result: await runtime.setupProjectExistingFolder(params)
    })
  }),
  defineMethod({
    name: 'projectHostSetup.clone',
    params: ProjectHostSetupClone,
    handler: async (params, { runtime }) => ({
      result: await runtime.setupProjectClone(params)
    })
  }),
  defineMethod({
    name: 'projectHostSetup.update',
    params: ProjectHostSetupUpdate,
    handler: (params, { runtime }) => ({
      result: runtime.updateProjectHostSetup(params)
    })
  }),
  defineMethod({
    name: 'projectHostSetup.delete',
    params: ProjectHostSetupDelete,
    handler: (params, { runtime }) => ({
      result: runtime.deleteProjectHostSetup(params)
    })
  })
]
