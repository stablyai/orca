import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../core'
import { OptionalFiniteNumber, OptionalString, requiredString } from '../schemas'
import { isTuiAgent } from '../../../../shared/tui-agent-config'
import { TaskSourceContextSchema } from '../../../../shared/task-source-context-schema'
import { WorkspaceLinkedItemSchema } from '../../../../shared/workspace-linked-item-schema'
import { isWorkspaceLinkedItemSourceContextMatch } from '../../../../shared/workspace-linked-item-source-context'

const FolderWorkspaceLinkedTask = WorkspaceLinkedItemSchema.nullable()

function assertLinkedTaskSourceContextMatch(
  value: {
    linkedTask?: z.infer<typeof FolderWorkspaceLinkedTask>
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

const FolderWorkspaceCreate = z
  .object({
    projectGroupId: requiredString('Missing project group id'),
    name: OptionalString,
    folderPath: OptionalString.nullable().optional(),
    connectionId: OptionalString.nullable().optional(),
    linkedTask: FolderWorkspaceLinkedTask.optional(),
    linkedTaskSourceContext: TaskSourceContextSchema.nullable().optional(),
    createdWithAgent: z.string().refine(isTuiAgent).optional(),
    pendingFirstAgentMessageRename: z.boolean().optional()
  })
  .superRefine(assertLinkedTaskSourceContextMatch)

const FolderWorkspaceUpdate = z.object({
  folderWorkspaceId: requiredString('Missing folder workspace id'),
  updates: z
    .object({
      name: OptionalString,
      folderPath: OptionalString,
      linkedTask: FolderWorkspaceLinkedTask.optional(),
      linkedTaskSourceContext: TaskSourceContextSchema.nullable().optional(),
      comment: z.string().optional(),
      isArchived: z.boolean().optional(),
      isUnread: z.boolean().optional(),
      isPinned: z.boolean().optional(),
      sortOrder: OptionalFiniteNumber,
      manualOrder: OptionalFiniteNumber,
      workspaceStatus: OptionalString,
      createdWithAgent: z.string().refine(isTuiAgent).optional(),
      pendingFirstAgentMessageRename: z.boolean().optional(),
      firstAgentMessageRenameError: z.string().nullable().optional(),
      lastActivityAt: OptionalFiniteNumber
    })
    .superRefine(assertLinkedTaskSourceContextMatch)
})

const FolderWorkspaceSelector = z.object({
  folderWorkspaceId: requiredString('Missing folder workspace id')
})

const FolderWorkspacePathStatus = z.discriminatedUnion('scope', [
  z.object({
    scope: z.literal('folder-workspace'),
    folderWorkspaceId: requiredString('Missing folder workspace id')
  }),
  z.object({
    scope: z.literal('project-group'),
    projectGroupId: requiredString('Missing project group id')
  }),
  z.object({
    scope: z.literal('path'),
    path: requiredString('Missing folder path'),
    connectionId: OptionalString.nullable().optional()
  })
])

export const FOLDER_WORKSPACE_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'folderWorkspace.list',
    params: null,
    handler: (_params, { runtime }) => ({
      folderWorkspaces: runtime.listFolderWorkspaces()
    })
  }),
  defineMethod({
    name: 'folderWorkspace.create',
    params: FolderWorkspaceCreate,
    handler: async (params, { runtime }) => ({
      folderWorkspace: await runtime.createFolderWorkspace(params)
    })
  }),
  defineMethod({
    name: 'folderWorkspace.update',
    params: FolderWorkspaceUpdate,
    handler: async (params, { runtime }) => ({
      folderWorkspace: await runtime.updateFolderWorkspace(params.folderWorkspaceId, params.updates)
    })
  }),
  defineMethod({
    name: 'folderWorkspace.delete',
    params: FolderWorkspaceSelector,
    handler: async (params, { runtime }) => runtime.deleteFolderWorkspace(params.folderWorkspaceId)
  }),
  defineMethod({
    name: 'folderWorkspace.getPathStatus',
    params: FolderWorkspacePathStatus,
    handler: async (params, { runtime }) => ({
      status: await runtime.getFolderWorkspacePathStatus(params)
    })
  })
]
