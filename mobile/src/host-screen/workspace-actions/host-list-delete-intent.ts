import type { ExecutionHostId } from '../../../../src/shared/execution-host/execution-host'
import type { Worktree } from '../../worktree/workspace-list/workspace-list-types'

// A session's ⋯ Delete opens the host list's own delete confirm: the session leaves a one-shot
// intent here and goes to /h/<host>?deleteWorkspace=<token>. Only that navigation carries the token,
// so a list opened any other way, a deep link, or a reload never opens a delete.
export const HOST_LIST_DELETE_PARAM = 'deleteWorkspace'

// Long enough for an in-document hop and a cached catalog; a stalled hop must not fire minutes later.
export const HOST_LIST_DELETE_INTENT_TTL_MS = 10_000

export type HostListDeleteTarget = {
  /** The paired desktop whose list owns the row. */
  hostId: string
  /** The session route's execution host: a `runtime:` server, or undefined for the desktop's own rows. */
  executionHost: ExecutionHostId | undefined
  worktreeId: string
}

type PendingIntent = HostListDeleteTarget & { token: string; expiresAt: number }

let pending: PendingIntent | null = null
let issued = 0

/** Records the intent, replacing any earlier one, and returns the token its navigation must carry. */
export function requestHostListDelete(target: HostListDeleteTarget, now = Date.now()): string {
  issued += 1
  const token = `${issued.toString(36)}${Math.random().toString(36).slice(2, 10)}`
  pending = { ...target, token, expiresAt: now + HOST_LIST_DELETE_INTENT_TTL_MS }
  return token
}

/** Hands the intent to the first list that presents its token; any presented token spends it. */
export function takeHostListDeleteIntent(
  token: string,
  hostId: string,
  now = Date.now()
): HostListDeleteTarget | null {
  const intent = pending
  if (!token || intent === null || intent.token !== token) {
    return null
  }
  pending = null
  if (intent.hostId !== hostId || now > intent.expiresAt) {
    return null
  }
  return { hostId: intent.hostId, executionHost: intent.executionHost, worktreeId: intent.worktreeId }
}

/** The one row the session showed: same id on the same execution host, never a same-id twin elsewhere. */
export function findHostListDeleteRow(
  rows: readonly Worktree[],
  target: HostListDeleteTarget
): Worktree | null {
  const matches = rows.filter(
    (row) =>
      row.worktreeId === target.worktreeId &&
      (target.executionHost === undefined
        ? !row.hostId?.startsWith('runtime:')
        : row.hostId === target.executionHost)
  )
  return matches.length === 1 ? matches[0] : null
}

export function resetHostListDeleteIntentForTest(): void {
  pending = null
}
