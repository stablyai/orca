// Runs on plain Node, as orcad does: a paired server stamps its own rows through this same wiring.
import { describe, expect, it, vi } from 'vitest'
import { HEADLESS_RUNTIME_WINDOW_ID } from '../../../shared/runtime-session-contracts'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'
import type { FolderWorkspace } from '../../../shared/folder-workspaces/folder-workspace-types'
import { AgentHookServer } from '../../agent-hooks/server/agent-hook-server'
import { OrcaRuntimeService } from '../orca-runtime'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import {
  hostWorktreeTarget,
  type HostWorktreeTarget
} from '../../../shared/worktree/host-qualified-identity'
import {
  partialRuntimeStore,
  storeRepo,
  storeWorktreeMeta
} from '../orca-runtime-tests/runtime-store-partial-fixture'

vi.mock('../../../shared/sidebar-inputs-switch', () => ({ ORCA_SIDEBAR_INPUTS_IS_MAIN: true }))

const WT = 'repo-1::/tmp/worktree-a'
const FOLDER_ID = 'fw-1'

function createHeadlessRuntime(
  stored: Pick<WorktreeMeta, 'lastActivityAt' | 'smartTier' | 'smartAt'> = { lastActivityAt: 0 },
  workspaceId = WT
) {
  const meta: Record<string, WorktreeMeta> = { [WT]: storeWorktreeMeta(stored) }
  // A folder workspace keeps its stamps and unread flag on its own record.
  const folder: FolderWorkspace = {
    id: FOLDER_ID,
    projectGroupId: 'group-1',
    name: 'Folder',
    folderPath: '/tmp/folder-a',
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    createdAt: 0,
    updatedAt: 0,
    ...stored
  }
  const written = new Set<(domains: readonly string[] | undefined) => void>()
  const repo = storeRepo({ id: 'repo-1', path: '/tmp/repo-1', connectionId: null })
  const store = {
    // An unstamped row's writes resolve their host from its repo's only registration.
    getRepos: () => [repo],
    getRepo: (id: string) => (id === repo.id ? repo : undefined),
    getSettings: () => ({}),
    getWorktreeMeta: (id: string) => meta[id],
    getAllWorktreeMeta: () => meta,
    setWorktreeMeta: ({ id }: HostWorktreeTarget, updates: Partial<WorktreeMeta>) => {
      meta[id] = { ...meta[id], ...updates }
      written.forEach((listener) => listener(['worktreeMeta']))
      return meta[id]
    },
    getFolderWorkspace: (id: string) => (id === FOLDER_ID ? folder : undefined),
    getFolderWorkspaces: () => [folder],
    updateFolderWorkspace: (_id: string, updates: Partial<FolderWorkspace>) => {
      Object.assign(folder, updates)
      written.forEach((listener) => listener(['folderWorkspaces']))
      return folder
    },
    onStateWritten: (listener: (domains: readonly string[] | undefined) => void) => {
      written.add(listener)
      return () => written.delete(listener)
    }
  }
  const runtime = new OrcaRuntimeService(partialRuntimeStore(store))
  // No window: a server with no client attached must still see its own bells and titles.
  runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, {
    tabs: [
      {
        tabId: 'tab-1',
        worktreeId: workspaceId,
        title: 'Terminal',
        activeLeafId: 'pane:1',
        layout: null
      }
    ],
    leaves: [
      {
        tabId: 'tab-1',
        worktreeId: workspaceId,
        leafId: 'pane:1',
        paneRuntimeId: 1,
        ptyId: 'pty-1',
        paneTitle: null
      }
    ]
  })
  return {
    runtime,
    meta,
    folder,
    setWorktreeMeta: store.setWorktreeMeta,
    updateFolderWorkspace: store.updateFolderWorkspace
  }
}

describe('host sort stamps on a headless runtime', () => {
  it.each(['worktree', 'folder'] as const)(
    're-tiers a read Done beside a Working pane when any writer clears the %s flag',
    (kind) => {
      vi.useFakeTimers({ now: 80_000 })
      try {
        const workspaceId = kind === 'folder' ? folderWorkspaceKey(FOLDER_ID) : WT
        const { runtime, meta, folder, setWorktreeMeta, updateFolderWorkspace } =
          createHeadlessRuntime(undefined, workspaceId)
        const record = (): Pick<WorktreeMeta, 'isUnread' | 'smartTier' | 'smartAt'> =>
          kind === 'folder' ? folder : meta[WT]
        const server = new AgentHookServer()
        runtime.attachAgentStatusStore(server)
        const pane = (id: string, state: 'working' | 'done'): void =>
          server.ingestTerminalStatus({
            paneKey: `tab-1:${id}`,
            tabId: 'tab-1',
            worktreeId: workspaceId,
            payload: { state, prompt: 'task', agentType: 'claude' }
          })
        pane('11111111-1111-4111-8111-111111111111', 'working')
        vi.setSystemTime(90_000)
        pane('22222222-2222-4222-8222-222222222222', 'working')
        vi.setSystemTime(100_000)
        pane('11111111-1111-4111-8111-111111111111', 'done')
        expect(record()).toMatchObject({ isUnread: true, smartTier: 'done', smartAt: 100_000 })

        // A client opened it (the window's metadata write, a phone, workspace activation).
        if (kind === 'folder') {
          updateFolderWorkspace(FOLDER_ID, { isUnread: false })
        } else {
          setWorktreeMeta(hostWorktreeTarget({ id: WT, hostId: 'local' }), { isUnread: false })
        }
        expect(record()).toMatchObject({ isUnread: false, smartTier: 'working', smartAt: 90_000 })
      } finally {
        vi.useRealTimers()
      }
    }
  )
})
