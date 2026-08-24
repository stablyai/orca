import { ipcMain } from 'electron'
import { connect, disconnect, getStatus, selectWorkspace, testConnection } from '../shortcut/client'
import { _resetPreflightCache } from './preflight'
import { ProviderCancellableRequests } from './provider-cancellable-requests'
import { getStory, getStoryComments, listStories, searchStories } from '../shortcut/stories'
import { addStoryComment, createStory, updateStory } from '../shortcut/story-mutations'
import { listMembers, listTeams, listWorkflows } from '../shortcut/workspace-directory'
import type {
  ShortcutStoryFilter,
  ShortcutStoryType,
  ShortcutStoryUpdate,
  ShortcutWorkspaceSelection
} from '../../shared/shortcut-types'

const VALID_FILTERS = new Set<ShortcutStoryFilter>(['assigned', 'requested', 'all', 'done'])
const VALID_STORY_TYPES = new Set<ShortcutStoryType>(['feature', 'bug', 'chore'])
const searchRequests = new ProviderCancellableRequests()

function normalizeWorkspaceId(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function normalizeWorkspaceSelection(value: unknown): ShortcutWorkspaceSelection | undefined {
  return normalizeWorkspaceId(value) as ShortcutWorkspaceSelection | undefined
}

function clampLimit(value: unknown, fallback = 30): number {
  const limit = typeof value === 'number' && Number.isFinite(value) ? value : fallback
  return Math.min(Math.max(1, limit), 100)
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (value === undefined) {
    return undefined
  }
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : undefined
}

function normalizeStoryUpdate(value: unknown): ShortcutStoryUpdate | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const input = value as ShortcutStoryUpdate
  if (input.title !== undefined && typeof input.title !== 'string') {
    return null
  }
  if (input.labels !== undefined && normalizeStringArray(input.labels) === undefined) {
    return null
  }
  if (input.ownerIds !== undefined && normalizeStringArray(input.ownerIds) === undefined) {
    return null
  }
  if (input.workflowStateId !== undefined && typeof input.workflowStateId !== 'string') {
    return null
  }
  if (input.storyType !== undefined && !VALID_STORY_TYPES.has(input.storyType)) {
    return null
  }
  return input
}

export function registerShortcutHandlers(): void {
  ipcMain.handle('shortcut:connect', async (_event, args: { apiToken: string }) => {
    if (typeof args?.apiToken !== 'string' || !args.apiToken.trim()) {
      return { ok: false, error: 'API token is required.' }
    }
    const result = await connect({ apiToken: args.apiToken })
    if (result.ok) {
      _resetPreflightCache()
    }
    return result
  })

  ipcMain.handle('shortcut:disconnect', async (_event, args?: { workspaceId?: string }) => {
    disconnect(normalizeWorkspaceId(args?.workspaceId))
    _resetPreflightCache()
  })

  ipcMain.handle(
    'shortcut:selectWorkspace',
    async (_event, args: { workspaceId: ShortcutWorkspaceSelection }) => {
      const workspaceId = normalizeWorkspaceSelection(args?.workspaceId)
      if (!workspaceId) {
        return getStatus()
      }
      return selectWorkspace(workspaceId)
    }
  )

  ipcMain.handle('shortcut:status', async () => {
    return getStatus()
  })

  ipcMain.handle('shortcut:readStatus', async () => {
    return getStatus()
  })

  ipcMain.handle('shortcut:testConnection', async (_event, args?: { workspaceId?: string }) => {
    return testConnection(normalizeWorkspaceId(args?.workspaceId))
  })

  ipcMain.handle(
    'shortcut:searchStories',
    async (
      _event,
      args: {
        query: string
        limit?: number
        workspaceId?: ShortcutWorkspaceSelection
        requestId?: string
      }
    ) => {
      if (typeof args?.query !== 'string') {
        return []
      }
      return searchRequests.run(args.requestId, (signal) =>
        searchStories(
          args.query,
          clampLimit(args.limit),
          normalizeWorkspaceSelection(args.workspaceId),
          signal
        )
      )
    }
  )

  ipcMain.handle('shortcut:cancelSearchStories', (_event, args: { requestId?: string }) => {
    searchRequests.cancel(args?.requestId)
  })

  ipcMain.handle(
    'shortcut:listStories',
    async (
      _event,
      args?: {
        filter?: ShortcutStoryFilter
        limit?: number
        workspaceId?: ShortcutWorkspaceSelection
      }
    ) => {
      const filter = VALID_FILTERS.has(args?.filter as ShortcutStoryFilter)
        ? (args!.filter as ShortcutStoryFilter)
        : undefined
      return listStories(
        filter,
        clampLimit(args?.limit),
        normalizeWorkspaceSelection(args?.workspaceId)
      )
    }
  )

  ipcMain.handle(
    'shortcut:getStory',
    async (_event, args: { storyId: string; workspaceId?: string }) => {
      if (typeof args?.storyId !== 'string' || !args.storyId.trim()) {
        return null
      }
      return getStory(args.storyId.trim(), normalizeWorkspaceId(args.workspaceId))
    }
  )

  ipcMain.handle(
    'shortcut:createStory',
    async (
      _event,
      args: {
        workspaceId?: string
        teamId?: string
        workflowStateId?: string
        storyType?: ShortcutStoryType
        title: string
        description?: string
      }
    ) => {
      if (typeof args?.title !== 'string' || !args.title.trim()) {
        return { ok: false, error: 'Title is required.' }
      }
      return createStory({
        workspaceId: normalizeWorkspaceId(args.workspaceId),
        teamId: normalizeWorkspaceId(args.teamId),
        workflowStateId: normalizeWorkspaceId(args.workflowStateId),
        storyType: VALID_STORY_TYPES.has(args.storyType as ShortcutStoryType)
          ? args.storyType
          : undefined,
        title: args.title.trim(),
        description: args.description?.trim() || undefined
      })
    }
  )

  ipcMain.handle(
    'shortcut:updateStory',
    async (
      _event,
      args: { storyId: string; updates: ShortcutStoryUpdate; workspaceId?: string }
    ) => {
      if (typeof args?.storyId !== 'string' || !args.storyId.trim()) {
        return { ok: false, error: 'Story ID is required.' }
      }
      const updates = normalizeStoryUpdate(args.updates)
      if (!updates) {
        return { ok: false, error: 'Updates object is required.' }
      }
      return updateStory(args.storyId.trim(), updates, normalizeWorkspaceId(args.workspaceId))
    }
  )

  ipcMain.handle(
    'shortcut:addStoryComment',
    async (_event, args: { storyId: string; body: string; workspaceId?: string }) => {
      if (typeof args?.storyId !== 'string' || !args.storyId.trim()) {
        return { ok: false, error: 'Story ID is required.' }
      }
      if (typeof args?.body !== 'string' || !args.body.trim()) {
        return { ok: false, error: 'Comment body is required.' }
      }
      return addStoryComment(
        args.storyId.trim(),
        args.body.trim(),
        normalizeWorkspaceId(args.workspaceId)
      )
    }
  )

  ipcMain.handle(
    'shortcut:storyComments',
    async (_event, args: { storyId: string; workspaceId?: string }) => {
      if (typeof args?.storyId !== 'string' || !args.storyId.trim()) {
        return []
      }
      return getStoryComments(args.storyId.trim(), normalizeWorkspaceId(args.workspaceId))
    }
  )

  ipcMain.handle(
    'shortcut:listTeams',
    async (_event, args?: { workspaceId?: ShortcutWorkspaceSelection }) => {
      return listTeams(normalizeWorkspaceSelection(args?.workspaceId))
    }
  )

  ipcMain.handle('shortcut:listWorkflows', async (_event, args?: { workspaceId?: string }) => {
    return listWorkflows(normalizeWorkspaceId(args?.workspaceId))
  })

  ipcMain.handle('shortcut:listMembers', async (_event, args?: { workspaceId?: string }) => {
    return listMembers(normalizeWorkspaceId(args?.workspaceId))
  })
}
