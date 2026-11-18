import type { ExecutionHostId } from '../../shared/execution-host/execution-host'
import type { Repo } from '../../shared/repository/repo-types'
import type { HostWorktreeTarget } from '../../shared/worktree/host-qualified-identity'
import type { ExternalConversationLinkStore } from './external-conversation-links'

export const WORKTREE = 'repo-1::/work/a'
export const PANE = 'tab-1:11111111-1111-4111-8111-111111111111'
export const LOCAL_REPO: Repo = {
  id: 'repo-1',
  path: '/work',
  displayName: 'repo',
  badgeColor: '#000000',
  addedAt: 0
}

type LinkRow = { externalConversations?: unknown; hostId?: ExecutionHostId }

/** Model canonical host rows separately from the locator map that keeps the first same-path host. */
export function fakeLinkStore(repos: Repo[] = [LOCAL_REPO]) {
  const byHost = new Map<ExecutionHostId, Record<string, LinkRow>>()
  const legacy: Record<string, LinkRow> = {}
  const folders: (LinkRow & { id: string })[] = []
  const writes: HostWorktreeTarget[] = []
  const rows = (hostId: ExecutionHostId): Record<string, LinkRow> => {
    const existing = byHost.get(hostId)
    if (existing) {
      return existing
    }
    const created: Record<string, LinkRow> = {}
    byHost.set(hostId, created)
    return created
  }
  const put = (id: string, hostId: ExecutionHostId, row: Omit<LinkRow, 'hostId'>): void => {
    const next = { ...rows(hostId)[id], ...row, hostId }
    rows(hostId)[id] = next
    if (!legacy[id] || legacy[id].hostId === hostId) {
      legacy[id] = next
    }
  }
  const remove = (id: string, hostId: ExecutionHostId = 'local'): void => {
    delete rows(hostId)[id]
    if (legacy[id]?.hostId === hostId) {
      delete legacy[id]
    }
  }
  const store = {
    getRepos: () => repos,
    getAllWorktreeMeta: () => legacy,
    getAllWorktreeMetaForHost: (hostId: ExecutionHostId) => rows(hostId),
    getWorktreeMeta: (id: string) => legacy[id],
    getWorktreeMetaForHost: (id: string, hostId: ExecutionHostId) => rows(hostId)[id],
    setWorktreeMeta: (target: HostWorktreeTarget, updates: { externalConversations: unknown }) => {
      writes.push(target)
      put(target.id, target.hostId, updates)
    },
    getFolderWorkspace: (id: string) => folders.find((folder) => folder.id === id),
    getFolderWorkspaces: () => folders,
    updateFolderWorkspace: (id: string, updates: { externalConversations: unknown }) => {
      const folder = folders.find((candidate) => candidate.id === id)
      if (folder) {
        folder.externalConversations = updates.externalConversations
      }
    }
  } satisfies ExternalConversationLinkStore
  const row = (id: string, hostId: ExecutionHostId = 'local'): LinkRow | undefined =>
    rows(hostId)[id]
  return { store, row, put, remove, folders, writes }
}
