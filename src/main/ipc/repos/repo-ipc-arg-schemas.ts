import { z } from 'zod'
import { isTuiAgent } from '../../../shared/tui-agent-config'
import { TaskSourceContextSchema } from '../../../shared/task-source-context-schema'
import { WorkspaceLinkedItemSchema } from '../../../shared/workspace-linked-item-schema'
import { isWorkspaceLinkedItemSourceContextMatch } from '../../../shared/workspace-linked-item-source-context'
import { DiffCommentSchema } from '../../../shared/diff-comment-schema'
import { normalizeExecutionHostId } from '../../../shared/execution-host'

export const ProjectGroupCreateArgs = z.object({
  name: z.string().min(1),
  parentPath: z.string().nullable().optional(),
  connectionId: z.string().nullable().optional(),
  parentGroupId: z.string().nullable().optional(),
  createdFrom: z.enum(['manual', 'folder-scan', 'migration']).optional()
})

export const ProjectGroupUpdateArgs = z.object({
  groupId: z.string().min(1),
  updates: z.object({
    name: z.string().optional(),
    isCollapsed: z.boolean().optional(),
    tabOrder: z.number().finite().optional(),
    color: z.string().nullable().optional()
  })
})

export const ProjectGroupSelectorArgs = z.object({
  groupId: z.string().min(1)
})

export const ProjectGroupMoveProjectArgs = z.object({
  projectId: z.string().min(1),
  groupId: z.string().nullable(),
  order: z.number().finite().optional()
})

export const ProjectHostSetupExistingFolderIpcArgs = z.object({
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

const LocalWindowsRuntimePreferenceIpcArgs = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('inherit-global') }),
  z.object({ kind: z.literal('windows-host') }),
  z.object({ kind: z.literal('wsl'), distro: z.string().min(1) })
])

export const ProjectUpdateIpcArgs = z.object({
  projectId: z.string().min(1),
  updates: z.object({
    localWindowsRuntimePreference: LocalWindowsRuntimePreferenceIpcArgs.optional()
  })
})

export const ProjectHostSetupCreateIpcArgs = z.object({
  projectId: z.string().min(1),
  hostId: z
    .string()
    .min(1)
    .transform((value, ctx) => {
      const hostId = normalizeExecutionHostId(value)
      if (!hostId) {
        ctx.addIssue({ code: 'custom', message: 'Invalid host ID' })
        return z.NEVER
      }
      return hostId
    }),
  setupId: z.string().min(1).optional(),
  path: z.string().optional(),
  kind: z.enum(['git', 'folder']).optional(),
  displayName: z.string().min(1).optional(),
  worktreeBasePath: z.string().optional(),
  gitUsername: z.string().optional(),
  setupState: z.enum(['ready', 'not-set-up', 'setting-up', 'error', 'unsupported']).optional(),
  setupMethod: z.enum(['imported-existing-folder', 'cloned', 'provisioned']).optional()
})

export const ProjectHostSetupUpdateIpcArgs = z.object({
  setupId: z.string().min(1),
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

export const ProjectHostSetupDeleteIpcArgs = z.object({
  setupId: z.string().min(1)
})

const FolderWorkspaceLinkedTaskArgs = WorkspaceLinkedItemSchema.nullable()

function assertFolderWorkspaceLinkedSourceContextMatch(
  value: {
    linkedTask?: z.infer<typeof FolderWorkspaceLinkedTaskArgs>
    linkedTaskSourceContext?: z.infer<typeof TaskSourceContextSchema> | null
  },
  ctx: z.RefinementCtx
): void {
  if (
    value.linkedTask &&
    value.linkedTaskSourceContext &&
    !isWorkspaceLinkedItemSourceContextMatch(value.linkedTask, value.linkedTaskSourceContext)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Linked task and source context identities must match'
    })
  }
}

export const FolderWorkspaceCreateArgs = z
  .object({
    projectGroupId: z.string().min(1),
    name: z.string().optional(),
    folderPath: z.string().nullable().optional(),
    connectionId: z.string().nullable().optional(),
    linkedTask: FolderWorkspaceLinkedTaskArgs.optional(),
    linkedTaskSourceContext: TaskSourceContextSchema.nullable().optional(),
    createdWithAgent: z.string().refine(isTuiAgent).optional(),
    pendingFirstAgentMessageRename: z.boolean().optional()
  })
  .superRefine(assertFolderWorkspaceLinkedSourceContextMatch)

export const FolderWorkspaceUpdateArgs = z.object({
  folderWorkspaceId: z.string().min(1),
  updates: z
    .object({
      name: z.string().optional(),
      folderPath: z.string().optional(),
      linkedTask: FolderWorkspaceLinkedTaskArgs.optional(),
      linkedTaskSourceContext: TaskSourceContextSchema.nullable().optional(),
      comment: z.string().optional(),
      isArchived: z.boolean().optional(),
      isUnread: z.boolean().optional(),
      isPinned: z.boolean().optional(),
      sortOrder: z.number().finite().optional(),
      manualOrder: z.number().finite().optional(),
      workspaceStatus: z.string().optional(),
      createdWithAgent: z.string().refine(isTuiAgent).optional(),
      pendingFirstAgentMessageRename: z.boolean().optional(),
      firstAgentMessageRenameError: z.string().nullable().optional(),
      lastActivityAt: z.number().finite().optional(),
      diffComments: z.array(DiffCommentSchema).optional()
    })
    .superRefine(assertFolderWorkspaceLinkedSourceContextMatch)
})

export const FolderWorkspaceSelectorArgs = z.object({
  folderWorkspaceId: z.string().min(1)
})

export const FolderWorkspacePathStatusArgs = z.discriminatedUnion('scope', [
  z.object({
    scope: z.literal('folder-workspace'),
    folderWorkspaceId: z.string().min(1)
  }),
  z.object({
    scope: z.literal('project-group'),
    projectGroupId: z.string().min(1)
  }),
  z.object({
    scope: z.literal('path'),
    path: z.string().min(1),
    connectionId: z.string().min(1).nullable().optional()
  })
])

export const ProjectGroupScanNestedArgs = z.object({
  path: z.string().min(1),
  connectionId: z.string().min(1).optional(),
  scanId: z.string().min(1).optional(),
  options: z.unknown().optional()
})

export const ProjectGroupCancelNestedScanArgs = z.object({
  scanId: z.string().min(1)
})

export const ProjectGroupImportNestedArgs = z.discriminatedUnion('mode', [
  z.object({
    parentPath: z.string().min(1),
    groupName: z.string().optional().default(''),
    projectPaths: z.array(z.string()),
    connectionId: z.string().min(1).optional(),
    scanId: z.string().min(1).optional(),
    mode: z.literal('group')
  }),
  z.object({
    parentPath: z.string().min(1),
    groupName: z.string().optional().default(''),
    projectPaths: z.array(z.string()),
    connectionId: z.string().min(1).optional(),
    scanId: z.string().min(1).optional(),
    mode: z.literal('separate')
  })
])

export function parseProjectGroupIpcArgs<T>(
  schema: z.ZodType<T>,
  value: unknown,
  errorCode: string
): T {
  const result = schema.safeParse(value)
  if (result.success) {
    return result.data
  }
  throw new Error(errorCode)
}
