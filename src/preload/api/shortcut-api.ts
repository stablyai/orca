import type {
  ShortcutComment,
  ShortcutConnectionStatus,
  ShortcutCreateStoryArgs,
  ShortcutCreateStoryResult,
  ShortcutMember,
  ShortcutMutationResult,
  ShortcutStory,
  ShortcutStoryFilter,
  ShortcutStoryUpdate,
  ShortcutTeam,
  ShortcutViewer,
  ShortcutWorkflow,
  ShortcutWorkspaceSelection
} from '../../shared/shortcut-types'

export type ShortcutApi = {
  connect: (args: {
    apiToken: string
  }) => Promise<{ ok: true; viewer: ShortcutViewer } | { ok: false; error: string }>
  disconnect: (args?: { workspaceId?: string }) => Promise<void>
  selectWorkspace: (args: {
    workspaceId: ShortcutWorkspaceSelection
  }) => Promise<ShortcutConnectionStatus>
  status: () => Promise<ShortcutConnectionStatus>
  readStatus: () => Promise<ShortcutConnectionStatus>
  testConnection: (args?: {
    workspaceId?: string
  }) => Promise<{ ok: true; viewer: ShortcutViewer } | { ok: false; error: string }>
  searchStories: (args: {
    query: string
    limit?: number
    workspaceId?: ShortcutWorkspaceSelection
    requestId?: string
  }) => Promise<ShortcutStory[]>
  cancelSearchStories: (args: { requestId: string }) => Promise<void>
  listStories: (args?: {
    filter?: ShortcutStoryFilter
    limit?: number
    workspaceId?: ShortcutWorkspaceSelection
  }) => Promise<ShortcutStory[]>
  getStory: (args: { storyId: string; workspaceId?: string }) => Promise<ShortcutStory | null>
  createStory: (args: ShortcutCreateStoryArgs) => Promise<ShortcutCreateStoryResult>
  updateStory: (args: {
    storyId: string
    updates: ShortcutStoryUpdate
    workspaceId?: string
  }) => Promise<ShortcutMutationResult>
  addStoryComment: (args: {
    storyId: string
    body: string
    workspaceId?: string
  }) => Promise<{ ok: true; id: string } | { ok: false; error: string }>
  storyComments: (args: { storyId: string; workspaceId?: string }) => Promise<ShortcutComment[]>
  listTeams: (args?: { workspaceId?: ShortcutWorkspaceSelection }) => Promise<ShortcutTeam[]>
  listWorkflows: (args?: { workspaceId?: string }) => Promise<ShortcutWorkflow[]>
  listMembers: (args?: { workspaceId?: string }) => Promise<ShortcutMember[]>
}
