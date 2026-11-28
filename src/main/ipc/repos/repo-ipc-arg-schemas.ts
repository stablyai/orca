import { lazyZodSchema } from '../../../shared/schema/lazy-zod-schema'
import { z } from 'zod'
import { isTuiAgent } from '../../../shared/agent-launch/catalog/tui-agent-config'
import { TaskSourceContextSchema } from '../../../shared/work-items/task-source-context-schema'
import { WorkspaceLinkedItemSchema } from '../../../shared/workspace-attachments/workspace-linked-item-schema'
import { WorkspaceAttachmentsSchema } from '../../../shared/workspace-attachments/workspace-attachment-schema'
import { isWorkspaceLinkedItemSourceContextMatch } from '../../../shared/workspace-attachments/workspace-linked-item-source-context'
import {
  DiffCommentDeliverySnapshotSchema,
  DiffCommentSchema
} from '../../../shared/file-review/diff-comment-schema'
import {
  FolderWorkspaceHookCreateShape,
  FolderWorkspaceDelete,
  assertFolderWorkspaceStartup
} from '../../../shared/rpc-contract/workspaces/folder-workspace-params'

export * from './project-group-ipc-arg-schemas'

const FolderWorkspaceLinkedTaskArgs = lazyZodSchema(() => WorkspaceLinkedItemSchema.nullable())

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

export const FolderWorkspaceCreateArgs = lazyZodSchema(() =>
  z
    .object({
      ...FolderWorkspaceHookCreateShape,
      projectGroupId: z.string().min(1),
      name: z.string().optional(),
      folderPath: z.string().nullable().optional(),
      connectionId: z.string().nullable().optional(),
      linkedTask: FolderWorkspaceLinkedTaskArgs.optional(),
      linkedItems: WorkspaceAttachmentsSchema.optional(),

      linkedTaskSourceContext: TaskSourceContextSchema.nullable().optional(),
      createdWithAgent: z.string().refine(isTuiAgent).optional(),
      pendingFirstAgentMessageRename: z.boolean().optional()
    })
    .superRefine(assertFolderWorkspaceLinkedSourceContextMatch)
    .superRefine(assertFolderWorkspaceStartup)
)

export const FolderWorkspaceUpdateArgs = lazyZodSchema(() =>
  z.object({
    folderWorkspaceId: z.string().min(1),
    updates: z
      .object({
        name: z.string().optional(),
        folderPath: z.string().optional(),
        linkedTask: FolderWorkspaceLinkedTaskArgs.optional(),
        linkedItems: WorkspaceAttachmentsSchema.optional(),
        linkedItemsBase: WorkspaceAttachmentsSchema.optional(),
        linkedItemsSelectionChanged: z.boolean().optional(),
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
        diffComments: z.array(DiffCommentSchema).optional(),
        diffCommentsBase: z.array(DiffCommentSchema).optional(),
        deliveredDiffCommentSnapshots: z.array(DiffCommentDeliverySnapshotSchema).optional()
      })
      .superRefine(assertFolderWorkspaceLinkedSourceContextMatch)
  })
)

export const FolderWorkspaceSelectorArgs = lazyZodSchema(() =>
  z.object({
    folderWorkspaceId: z.string().min(1)
  })
)

export const FolderWorkspaceDeleteArgs = FolderWorkspaceDelete

export const FolderWorkspacePathStatusArgs = lazyZodSchema(() =>
  z.discriminatedUnion('scope', [
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
)

export const ProjectGroupScanNestedArgs = lazyZodSchema(() =>
  z.object({
    path: z.string().min(1),
    connectionId: z.string().min(1).optional(),
    scanId: z.string().min(1).optional(),
    options: z.unknown().optional()
  })
)

export const ProjectGroupCancelNestedScanArgs = lazyZodSchema(() =>
  z.object({
    scanId: z.string().min(1)
  })
)

export const ProjectGroupImportNestedArgs = lazyZodSchema(() =>
  z.discriminatedUnion('mode', [
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
)

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
