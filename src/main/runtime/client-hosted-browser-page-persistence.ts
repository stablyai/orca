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

/**
 * The placement a rehydrated row carries until a host takes it back.
 *
 * A registry entry cannot exist without a placement, and a persisted row has no honest one: its
 * authority died with the previous runtime. Rather than replay a stored generation -- which would
 * be a forged authority -- rehydration stamps this sentinel. Generation 0 is below every generation
 * the counters can issue (both start at 1), so it can never collide with a live placement, and the
 * host id names no client, so no lease ever matches it by identity.
 */
export const RESTORED_CLIENT_HOSTED_BROWSER_PLACEMENT: RuntimeBrowserClientPlacement =
  Object.freeze({
    kind: 'client',
    browserHostClientId: 'restored-client-host',
    browserHostGeneration: 0,
    pageHostGeneration: 0
  })

/**
 * The execution-host key a rehydrated row carries until recovery resolves the real one.
 *
 * A route key names the runtime process that minted it, so the persisted record deliberately has
 * none. The registry still requires a key, and a sentinel is honest about that: it matches no
 * inventory entry, so a returning host's page can never be mistaken for one already placed under
 * the right host.
 */
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

/**
 * Rewrites one worktree's persisted rows to match the registry.
 *
 * Create, navigate, committed metadata, recovery, retirement and host quit all converge on the
 * runtime's single tab-change announcement, so this reads the registry there rather than growing a
 * write path per event. It is a no-op when the projection is unchanged, which is what makes it
 * safe to call from that hot seam.
 */
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
    // Why swallow: a worktree that no longer resolves has no partition to write to, and the row it
    // would have carried is one rehydration already refuses to restore.
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
  /** Every persisted session partition this runtime can read, in no particular order. */
  listWorkspaceSessions(): readonly WorkspaceSessionState[]
  /** Whether the worktree the rows name still exists here; a gone one is never restored. */
  isKnownWorktree(worktreeId: string): boolean
  now?: () => number
}

/**
 * Republishes persisted rows into the page registry as held rows.
 *
 * Held is the whole point: a row with no live placement is already the state a host quit produces,
 * which the snapshot projection, the host-row projection, `browserTabClose`'s registry-hit branch
 * and reopen-on-server all handle today. Rehydration lands in that state rather than inventing a
 * restored one, so nothing downstream has to learn a new case.
 */
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
            // Why not loading: nothing is driving this page, so a carried-over spinner would never
            // settle -- the same reason a host-quit row reports settled.
            loading: false,
            // Why never active: the returning host republishes its own focus, and claiming it here
            // would deactivate whichever sibling that host is actually showing.
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

/**
 * Whether an otherwise-unchanged projection is old enough to rewrite.
 *
 * The equality check deliberately ignores `savedAt`, so a tab the user leaves open on one URL
 * would keep its first timestamp forever and age out of the expiry bound while its host was
 * holding it the whole time. Refreshing on a coarse interval keeps the bound meaning "nobody has
 * held this page in a month" without making the announcement write on every call.
 */
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
