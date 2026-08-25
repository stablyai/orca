import { z } from 'zod'
import { defineMethod, type RpcAnyMethod } from '../core'
import {
  OptionalFiniteNumber,
  OptionalPlainString,
  OptionalString,
  requiredString
} from '../schemas'

const VALID_FILTERS = ['assigned', 'requested', 'all', 'done'] as const
const STORY_TYPES = ['feature', 'bug', 'chore'] as const

const WorkspaceSelection = z
  .object({
    workspaceId: OptionalString
  })
  .optional()

const Connect = z.object({
  apiToken: requiredString('API token is required')
})

const SelectWorkspace = z.object({
  workspaceId: requiredString('Workspace ID is required')
})

const SearchStories = z.object({
  query: requiredString('Missing query'),
  limit: OptionalFiniteNumber,
  workspaceId: OptionalString
})

const ListStories = z
  .object({
    filter: z.enum(VALID_FILTERS).optional(),
    limit: OptionalFiniteNumber,
    workspaceId: OptionalString
  })
  .optional()

const StoryId = z.object({
  storyId: requiredString('Story ID is required'),
  workspaceId: OptionalString
})

const CreateStory = z.object({
  workspaceId: OptionalString,
  teamId: OptionalString,
  workflowStateId: OptionalString,
  storyType: z.enum(STORY_TYPES).optional(),
  title: requiredString('Title is required'),
  description: OptionalPlainString
})

const StoryUpdate = z.object({
  storyId: requiredString('Story ID is required'),
  workspaceId: OptionalString,
  updates: z.object({
    title: OptionalString,
    labels: z.array(z.string()).optional(),
    ownerIds: z.array(z.string()).optional(),
    workflowStateId: OptionalString,
    storyType: z.enum(STORY_TYPES).optional()
  })
})

const StoryComment = z.object({
  storyId: requiredString('Story ID is required'),
  body: requiredString('Comment body is required'),
  workspaceId: OptionalString
})

export const SHORTCUT_METHODS: RpcAnyMethod[] = [
  defineMethod({
    name: 'shortcut.connect',
    params: Connect,
    handler: async (params, { runtime }) =>
      runtime.shortcutConnect({ apiToken: params.apiToken.trim() })
  }),
  defineMethod({
    name: 'shortcut.disconnect',
    params: WorkspaceSelection,
    handler: async (params, { runtime }) => runtime.shortcutDisconnect(params?.workspaceId)
  }),
  defineMethod({
    name: 'shortcut.selectWorkspace',
    params: SelectWorkspace,
    handler: async (params, { runtime }) =>
      runtime.shortcutSelectWorkspace(params.workspaceId.trim())
  }),
  defineMethod({
    name: 'shortcut.status',
    params: null,
    handler: async (_params, { runtime }) => runtime.shortcutStatus()
  }),
  defineMethod({
    name: 'shortcut.readStatus',
    params: null,
    handler: async (_params, { runtime }) => runtime.shortcutReadStatus()
  }),
  defineMethod({
    name: 'shortcut.testConnection',
    params: WorkspaceSelection,
    handler: async (params, { runtime }) => runtime.shortcutTestConnection(params?.workspaceId)
  }),
  defineMethod({
    name: 'shortcut.searchStories',
    params: SearchStories,
    handler: async (params, { runtime, signal }) =>
      runtime.shortcutSearchStories(params.query, params.limit, params.workspaceId, signal)
  }),
  defineMethod({
    name: 'shortcut.listStories',
    params: ListStories,
    handler: async (params, { runtime }) =>
      runtime.shortcutListStories(params?.filter, params?.limit, params?.workspaceId)
  }),
  defineMethod({
    name: 'shortcut.getStory',
    params: StoryId,
    handler: async (params, { runtime }) =>
      runtime.shortcutGetStory(params.storyId.trim(), params.workspaceId)
  }),
  defineMethod({
    name: 'shortcut.createStory',
    params: CreateStory,
    handler: async (params, { runtime }) =>
      runtime.shortcutCreateStory({
        workspaceId: params.workspaceId,
        teamId: params.teamId,
        workflowStateId: params.workflowStateId,
        storyType: params.storyType,
        title: params.title.trim(),
        description: params.description?.trim() || undefined
      })
  }),
  defineMethod({
    name: 'shortcut.updateStory',
    params: StoryUpdate,
    handler: async (params, { runtime }) =>
      runtime.shortcutUpdateStory(params.storyId.trim(), params.updates, params.workspaceId)
  }),
  defineMethod({
    name: 'shortcut.addStoryComment',
    params: StoryComment,
    handler: async (params, { runtime }) =>
      runtime.shortcutAddStoryComment(params.storyId.trim(), params.body.trim(), params.workspaceId)
  }),
  defineMethod({
    name: 'shortcut.storyComments',
    params: StoryId,
    handler: async (params, { runtime }) =>
      runtime.shortcutStoryComments(params.storyId.trim(), params.workspaceId)
  }),
  defineMethod({
    name: 'shortcut.listTeams',
    params: WorkspaceSelection,
    handler: async (params, { runtime }) => runtime.shortcutListTeams(params?.workspaceId)
  }),
  defineMethod({
    name: 'shortcut.listWorkflows',
    params: WorkspaceSelection,
    handler: async (params, { runtime }) => runtime.shortcutListWorkflows(params?.workspaceId)
  }),
  defineMethod({
    name: 'shortcut.listMembers',
    params: WorkspaceSelection,
    handler: async (params, { runtime }) => runtime.shortcutListMembers(params?.workspaceId)
  })
]
