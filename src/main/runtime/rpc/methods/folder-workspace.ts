import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../core'
import { OptionalFiniteNumber, OptionalString, requiredString } from '../schemas'
import { isTuiAgent } from '../../../../shared/tui-agent-config'

const FolderWorkspaceLinkedTask = z
  .object({
    provider: z.enum(['github', 'gitlab', 'linear', 'jira']),
    type: z.enum(['issue', 'pr', 'mr']),
    number: z.number().finite(),
    title: requiredString('Missing linked task title'),
    url: requiredString('Missing linked task URL'),
    linearIdentifier: OptionalString,
    jiraIdentifier: OptionalString,
    repoId: OptionalString
  })
  .nullable()

const FolderWorkspaceCreate = z.object({
  projectGroupId: requiredString('Missing project group id'),
  name: OptionalString,
  folderPath: OptionalString.nullable().optional(),
  connectionId: OptionalString.nullable().optional(),
  linkedTask: FolderWorkspaceLinkedTask.optional(),
  createdWithAgent: z.string().refine(isTuiAgent).optional(),
  pendingFirstAgentMessageRename: z.boolean().optional()
})

const FolderWorkspaceUpdate = z.object({
  folderWorkspaceId: requiredString('Missing folder workspace id'),
  updates: z.object({
    name: OptionalString,
    folderPath: OptionalString,
    linkedTask: FolderWorkspaceLinkedTask.optional(),
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
