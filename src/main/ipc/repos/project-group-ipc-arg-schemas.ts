import { z } from 'zod'
import { lazyZodSchema } from '../../../shared/schema/lazy-zod-schema'
import { WorkspaceHookSettingsSchema } from '../../../shared/workspace-setup/hooks/workspace-hook-settings-schema'
import { normalizeExecutionHostId } from '../../../shared/execution-host/execution-host'

export const ProjectGroupCreateArgs = lazyZodSchema(() =>
  z.object({
    name: z.string().min(1),
    parentPath: z.string().nullable().optional(),
    connectionId: z.string().nullable().optional(),
    parentGroupId: z.string().nullable().optional(),
    createdFrom: z.enum(['manual', 'folder-scan', 'migration']).optional()
  })
)

export const ProjectGroupUpdateArgs = lazyZodSchema(() =>
  z.object({
    groupId: z.string().min(1),
    updates: z.object({
      hookSettings: WorkspaceHookSettingsSchema.optional(),
      name: z.string().optional(),
      isCollapsed: z.boolean().optional(),
      tabOrder: z.number().finite().optional(),
      rootProjectOrder: z.number().finite().nullable().optional(),
      color: z.string().nullable().optional()
    })
  })
)

export const ProjectGroupSelectorArgs = lazyZodSchema(() =>
  z.object({
    groupId: z.string().min(1)
  })
)

export const ProjectGroupUpdateManyArgs = lazyZodSchema(() =>
  z.object({
    mutations: z.array(ProjectGroupUpdateArgs)
  })
)

export const ProjectHostSetupExistingFolderIpcArgs = lazyZodSchema(() =>
  z.object({
    projectId: z.string().min(1),
    projectProviderIdentity: z
      .object({
        provider: z.literal('github'),
        owner: z.string().min(1),
        repo: z.string().min(1),
        host: z.string().min(1).optional()
      })
      .optional(),
    hostId: z.string().min(1),
    path: z.string().min(1),
    kind: z.enum(['git', 'folder']).optional(),
    displayName: z.string().min(1).optional(),
    setupMethod: z.enum(['imported-existing-folder', 'cloned']).optional()
  })
)

const LocalWindowsRuntimePreferenceIpcArgs = lazyZodSchema(() =>
  z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('inherit-global') }),
    z.object({ kind: z.literal('windows-host') }),
    z.object({
      kind: z.literal('wsl'),
      distro: z.string().min(1),
      git: z.literal('windows-host').optional()
    })
  ])
)

export const ProjectUpdateIpcArgs = lazyZodSchema(() =>
  z.object({
    projectId: z.string().min(1),
    updates: z.object({
      localWindowsRuntimePreference: LocalWindowsRuntimePreferenceIpcArgs.optional()
    })
  })
)

const IpcExecutionHostId = lazyZodSchema(() =>
  z
    .string()
    .min(1)
    .transform((value, ctx) => {
      const hostId = normalizeExecutionHostId(value)
      if (!hostId) {
        ctx.addIssue({ code: 'custom', message: 'Invalid host ID' })
        return z.NEVER
      }
      return hostId
    })
)

// Omitted host retains legacy behavior: move the first matching project ID.
export const ProjectGroupMoveProjectArgs = lazyZodSchema(() =>
  z.object({
    projectId: z.string().min(1),
    groupId: z.string().nullable(),
    order: z.number().finite().optional(),
    hostId: IpcExecutionHostId.optional()
  })
)

export const ProjectHostSetupCreateIpcArgs = lazyZodSchema(() =>
  z.object({
    projectId: z.string().min(1),
    hostId: IpcExecutionHostId,
    setupId: z.string().min(1).optional(),
    path: z.string().optional(),
    kind: z.enum(['git', 'folder']).optional(),
    displayName: z.string().min(1).optional(),
    worktreeBasePath: z.string().optional(),
    gitUsername: z.string().optional(),
    setupState: z.enum(['ready', 'not-set-up', 'setting-up', 'error', 'unsupported']).optional(),
    setupMethod: z.enum(['imported-existing-folder', 'cloned', 'provisioned']).optional()
  })
)

export const ProjectHostSetupUpdateIpcArgs = lazyZodSchema(() =>
  z.object({
    setupId: z.string().min(1),
    hostId: IpcExecutionHostId.optional(),
    updates: z.object({
      displayName: z.string().optional(),
      path: z.string().optional(),
      worktreeBasePath: z.string().optional(),
      setupState: z.enum(['ready', 'not-set-up', 'setting-up', 'error', 'unsupported']).optional(),
      setupMethod: z
        .enum(['legacy-repo', 'imported-existing-folder', 'cloned', 'provisioned'])
        .optional(),
      gitUsername: z.string().optional(),
      kind: z.enum(['git', 'folder']).optional()
    })
  })
)

export const ProjectHostSetupDeleteIpcArgs = lazyZodSchema(() =>
  z.object({
    setupId: z.string().min(1),
    hostId: IpcExecutionHostId.optional()
  })
)
