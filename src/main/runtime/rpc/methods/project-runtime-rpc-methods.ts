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

const LocalWindowsRuntimePreference = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('inherit-global') }),
  z.object({ kind: z.literal('windows-host') }),
  z.object({ kind: z.literal('wsl'), distro: requiredString('Missing WSL distro') })
])
const TerminalBackendPreference = z.enum(['inherit', 'orca', 'herdr'])
const TerminalBackendActivation = z.discriminatedUnion('state', [
  z.object({ state: z.literal('ready'), backend: z.enum(['orca', 'herdr']) }),
  z.object({
    state: z.literal('migrating'),
    backend: z.enum(['orca', 'herdr']),
    migrationId: z.string().min(1),
    target: z.enum(['orca', 'herdr']),
    phase: z.enum(['preparing', 'committing'])
  })
])

const ProjectUpdate = z.object({
  projectId: requiredString('Missing project ID'),
  updates: z.object({
    localWindowsRuntimePreference: LocalWindowsRuntimePreference.optional(),
    herdrSessionName: z.string().trim().min(1).max(64).optional(),
    terminalBackendPreference: TerminalBackendPreference.optional(),
    terminalBackendByHost: z.record(z.string(), TerminalBackendActivation).optional()
  })
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
