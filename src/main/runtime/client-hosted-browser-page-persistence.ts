import {
  CLIENT_HOSTED_BROWSER_PAGE_MAX_AGE_MS,
  CLIENT_HOSTED_BROWSER_PAGE_REFRESH_MS,
  CLIENT_HOSTED_BROWSER_PAGE_RECORD_VERSION,
  type PersistedClientHostedBrowserPage
} from '../../shared/client-hosted-browser-page-record'
import type { RuntimeBrowserClientPlacement } from '../../shared/runtime-browser-placement'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import type {
  RuntimeBrowserClientPage,
  RuntimeBrowserPageRegistry
} from './runtime-browser-page-registry'

/** Persisted authority died with the prior runtime. Generation 0 and a nonexistent host
 * represent a held page without forging a placement or colliding with live generations (which start at 1). */
export const RESTORED_CLIENT_HOSTED_BROWSER_PLACEMENT: RuntimeBrowserClientPlacement =
  Object.freeze({
    kind: 'client',
    browserHostClientId: 'restored-client-host',
    browserHostGeneration: 0,
    pageHostGeneration: 0
  })

/** Route keys name their creating runtime; this sentinel matches no inventory until recovery resolves one. */
export const RESTORED_CLIENT_HOSTED_EXECUTION_HOST_KEY = 'restored-client-host-execution'

export function isRestoredClientHostedBrowserPlacement(
  placement: RuntimeBrowserClientPlacement
): boolean {
  return (
    placement.browserHostGeneration ===
      RESTORED_CLIENT_HOSTED_BROWSER_PLACEMENT.browserHostGeneration &&
    placement.pageHostGeneration === RESTORED_CLIENT_HOSTED_BROWSER_PLACEMENT.pageHostGeneration &&
    placement.browserHostClientId === RESTORED_CLIENT_HOSTED_BROWSER_PLACEMENT.browserHostClientId
  )
}

export type ClientHostedBrowserPagePersistenceHost = {
  getWorkspaceSession(worktreeId: string): WorkspaceSessionState | null
  setWorkspaceSession(worktreeId: string, session: WorkspaceSessionState): void
  now?: () => number
}

/** Persist the registry projection at the shared tab-change seam; unchanged projections write nothing. */
export function persistClientHostedBrowserPages(
  host: ClientHostedBrowserPagePersistenceHost,
  registry: Pick<RuntimeBrowserPageRegistry, 'listPages'>,
  worktreeId: string
): boolean {
  const rows = buildPersistedClientHostedBrowserPages(
    registry.listPages(worktreeId),
    host.now?.() ?? Date.now()
  )
  let session: WorkspaceSessionState | null
  try {
    session = host.getWorkspaceSession(worktreeId)
  } catch {
    return false
  }
  if (!session) {
    return false
  }
  const existing = session.clientHostedBrowserPagesByWorktree ?? {}
  if (
    samePersistedClientHostedBrowserPages(existing[worktreeId], rows) &&
    !needsAgeRefresh(existing[worktreeId], rows[0]?.savedAt ?? 0)
  ) {
    return false
  }
  const next = { ...existing }
  if (rows.length === 0) {
    delete next[worktreeId]
  } else {
    next[worktreeId] = rows
  }
  try {
    host.setWorkspaceSession(worktreeId, {
      ...session,
      clientHostedBrowserPagesByWorktree: next
    })
  } catch {
    // Missing worktrees have no writable partition and will not rehydrate.
    return false
  }
  return true
}

export function buildPersistedClientHostedBrowserPages(
  pages: readonly RuntimeBrowserClientPage[],
  savedAt: number
): PersistedClientHostedBrowserPage[] {
  return pages.flatMap((page) =>
    page.pairedDeviceId === undefined
      ? []
      : [
          {
            v: CLIENT_HOSTED_BROWSER_PAGE_RECORD_VERSION,
            browserPageId: page.browserPageId,
            workspaceId: page.workspaceId,
            browserProfileId: page.browserProfileId,
            url: page.url,
            title: page.title,
            pairedDeviceId: page.pairedDeviceId,
            savedAt
          } satisfies PersistedClientHostedBrowserPage
        ]
  )
}

export type ClientHostedBrowserPageRehydrationSource = {
  listWorkspaceSessions(): readonly WorkspaceSessionState[]
  isKnownWorktree(worktreeId: string): boolean
  now?: () => number
}

/** Rehydrate as held pages, reusing the state produced by host quit and understood by existing consumers. */
export function rehydrateClientHostedBrowserPages(
  registry: Pick<RuntimeBrowserPageRegistry, 'getPage' | 'publishClientPage'>,
  source: ClientHostedBrowserPageRehydrationSource
): readonly string[] {
  const now = source.now?.() ?? Date.now()
  const restored: string[] = []
  for (const session of source.listWorkspaceSessions()) {
    for (const [worktreeId, rows] of Object.entries(
      session.clientHostedBrowserPagesByWorktree ?? {}
    )) {
      if (!Array.isArray(rows) || !source.isKnownWorktree(worktreeId)) {
        continue
      }
      for (const row of rows) {
        if (
          row.workspaceId !== worktreeId ||
          now - row.savedAt > CLIENT_HOSTED_BROWSER_PAGE_MAX_AGE_MS ||
          registry.getPage(row.browserPageId) !== undefined
        ) {
          continue
        }
        try {
          registry.publishClientPage({
            browserPageId: row.browserPageId,
            workspaceId: row.workspaceId,
            browserProfileId: row.browserProfileId,
            executionHostKey: RESTORED_CLIENT_HOSTED_EXECUTION_HOST_KEY,
            placement: RESTORED_CLIENT_HOSTED_BROWSER_PLACEMENT,
            pairedDeviceId: row.pairedDeviceId,
            url: row.url,
            title: row.title,
            // No host can finish an inherited load spinner.
            loading: false,
            // The returning host owns focus; do not deactivate its actual selected sibling.
            active: false
          })
          restored.push(row.browserPageId)
        } catch (error) {
          console.warn('[browser-host-lease] client page rehydration rejected a row:', {
            browserPageId: row.browserPageId,
            error
          })
        }
      }
    }
  }
  return restored
}

/** Equality ignores savedAt; refresh coarse timestamps so live unchanged tabs do not expire as abandoned. */
function needsAgeRefresh(
  existing: readonly PersistedClientHostedBrowserPage[] | undefined,
  now: number
): boolean {
  return (existing ?? []).some((row) => now - row.savedAt > CLIENT_HOSTED_BROWSER_PAGE_REFRESH_MS)
}

function samePersistedClientHostedBrowserPages(
  left: readonly PersistedClientHostedBrowserPage[] | undefined,
  right: readonly PersistedClientHostedBrowserPage[]
): boolean {
  if ((left?.length ?? 0) !== right.length) {
    return false
  }
  return (left ?? []).every((row, index) => {
    const next = right[index]
    return (
      next !== undefined &&
      row.browserPageId === next.browserPageId &&
      row.workspaceId === next.workspaceId &&
      row.browserProfileId === next.browserProfileId &&
      row.url === next.url &&
      row.title === next.title &&
      row.pairedDeviceId === next.pairedDeviceId
    )
  })
}
