import { normalizeExecutionHostId } from '../../../src/shared/execution-host'
import {
  HOST_LIST_TARGET,
  hostRepoCatalogQuery,
  hostWorktreeCatalogKey,
  hostWorktreeCatalogQuery,
  NO_HOST_LIST_INPUT
} from '../host-screen/host-list-queries'
import { hostViewFamily, hostViewKey } from '../host-screen/host-view-memory'
import { hostProjectSectionsQuery } from '../host-screen/use-host-project-sections'
import { sessionTabsFamily, sessionTabsKey } from '../session/tabs/mobile-session-last-tabs'
import { gitStatusQuery } from '../source-control/mobile-git-status-query'
import { firstPaintTaskKeys } from '../tasks/task-query-storage'
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
  const keys =
    screen === undefined
      ? [
          persistedHostQueryKey(hostWorktreeCatalogQuery, hostWorktreeCatalogKey(hostId)),
          persistedHostQueryKey(hostViewFamily, hostViewKey(hostId)),
          persistedHostQueryKey(
            hostRepoCatalogQuery,
            hostQueryKey(hostId, hostRepoCatalogQuery.family, HOST_LIST_TARGET, NO_HOST_LIST_INPUT)
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
