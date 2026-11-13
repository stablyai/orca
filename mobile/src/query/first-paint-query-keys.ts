import type { QueryClient } from '@tanstack/react-query'
import { normalizeExecutionHostId } from '../../../src/shared/execution-host'
import { accountsSnapshotFamily, accountsSnapshotKey } from '../accounts/accounts-snapshot-stream'
import {
  HOST_LIST_TARGET,
  hostRepoCatalogQuery,
  hostRepoLabelsQuery,
  hostServerWorkspacesInput,
  hostServerWorkspacesQuery,
  hostWorktreeCatalogKey,
  hostWorktreeCatalogQuery,
  NO_HOST_LIST_INPUT
} from '../host-screen/host-list-queries'
import { hostViewFamily, hostViewKey } from '../host-screen/host-view-memory'
import { hostProjectSectionsQuery } from '../host-screen/use-host-project-sections'
import { sessionTabsFamily, sessionTabsKey } from '../session/tabs/mobile-session-last-tabs'
import type { MobileSessionTab } from '../session/tabs/mobile-session-tabs'
import { activeSessionTabOf } from '../session/tabs/active-session-tab'
import { storedTabChatTranscriptIdentity } from '../session/native-chat/transcript/mobile-native-chat-transcript-store'
import { gitStatusQuery } from '../source-control/mobile-git-status-query'
import { firstPaintTaskKeys } from '../tasks/screen-state/task-query-storage'
import { hostQueryKey } from './host-query-key'
import { persistedHostQueryKey, type PersistedHostQueryKey } from './host-query-persistence'

function routeSegment(segment: string | undefined): string | null {
  if (!segment) {
    return null
  }
  try {
    return decodeURIComponent(segment)
  } catch {
    return null
  }
}

/**
 * The stored keys a route's first screen draws, read once before the page renders. Every other key
 * restores when a screen first observes it.
 */
export function firstPaintQueryKeys(hostId: string, route: URL): PersistedHostQueryKey[] {
  const [root, routeHost, screen, worktreeSegment] = route.pathname.split('/').filter(Boolean)
  if (root !== 'h' || routeSegment(routeHost) !== hostId) {
    return []
  }
  if (screen === 'tasks') {
    return firstPaintTaskKeys(hostId)
  }
  if (screen === 'accounts') {
    return [persistedHostQueryKey(accountsSnapshotFamily, accountsSnapshotKey(hostId))].filter(
      (key) => key !== null
    )
  }
  if (screen === 'new-workspace') {
    // The drawer's existing-workspace check and host labels.
    return [
      persistedHostQueryKey(hostWorktreeCatalogQuery, hostWorktreeCatalogKey(hostId)),
      persistedHostQueryKey(
        hostRepoLabelsQuery,
        hostQueryKey(hostId, hostRepoLabelsQuery.family, HOST_LIST_TARGET, NO_HOST_LIST_INPUT)
      )
    ].filter((key) => key !== null)
  }
  const keys =
    screen === undefined
      ? [
          persistedHostQueryKey(hostWorktreeCatalogQuery, hostWorktreeCatalogKey(hostId)),
          persistedHostQueryKey(hostViewFamily, hostViewKey(hostId)),
          persistedHostQueryKey(
            hostServerWorkspacesQuery,
            hostQueryKey(
              hostId,
              hostServerWorkspacesQuery.family,
              HOST_LIST_TARGET,
              hostServerWorkspacesInput(null)
            )
          ),
          persistedHostQueryKey(
            hostRepoCatalogQuery,
            hostQueryKey(hostId, hostRepoCatalogQuery.family, HOST_LIST_TARGET, NO_HOST_LIST_INPUT)
          ),
          persistedHostQueryKey(
            hostRepoLabelsQuery,
            hostQueryKey(hostId, hostRepoLabelsQuery.family, HOST_LIST_TARGET, NO_HOST_LIST_INPUT)
          ),
          persistedHostQueryKey(
            hostProjectSectionsQuery,
            hostQueryKey(
              hostId,
              hostProjectSectionsQuery.family,
              HOST_LIST_TARGET,
              NO_HOST_LIST_INPUT
            )
          )
        ]
      : workspaceScreenKeys(hostId, screen, route, routeSegment(worktreeSegment))
  return keys.filter((key) => key !== null)
}

function workspaceScreenKeys(
  hostId: string,
  screen: string,
  route: URL,
  worktreeId: string | null
): (PersistedHostQueryKey | null)[] {
  if (worktreeId === null) {
    return []
  }
  // The same exec WorkspaceRoute gives the screen; absent means the paired desktop.
  const exec = normalizeExecutionHostId(route.searchParams.get('executionHost')) ?? 'local'
  if (screen === 'session') {
    return [persistedHostQueryKey(sessionTabsFamily, sessionTabsKey(hostId, exec, worktreeId))]
  }
  if (screen === 'source-control') {
    return [
      persistedHostQueryKey(
        gitStatusQuery,
        hostQueryKey(hostId, gitStatusQuery.family, { exec, worktree: worktreeId }, {})
      )
    ]
  }
  return []
}

/**
 * The chat a session route opens on, named by its stored strip once the first read restored it: the boot's
 * second, dependent read. Null on other routes and for a strip whose active tab is no chat.
 */
export function firstPaintChatTranscriptIdentity(
  queryClient: QueryClient,
  hostId: string,
  route: URL
): string | null {
  const [root, routeHost, screen, worktreeSegment] = route.pathname.split('/').filter(Boolean)
  const worktreeId = routeSegment(worktreeSegment)
  if (root !== 'h' || routeSegment(routeHost) !== hostId || screen !== 'session' || !worktreeId) {
    return null
  }
  const exec = normalizeExecutionHostId(route.searchParams.get('executionHost')) ?? 'local'
  const tabs = queryClient.getQueryData<MobileSessionTab[]>(
    sessionTabsKey(hostId, exec, worktreeId)
  )
  const active = tabs ? activeSessionTabOf(tabs) : null
  return active ? storedTabChatTranscriptIdentity(hostId, worktreeId, active) : null
}
