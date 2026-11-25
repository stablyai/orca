import type { ExecutionHostId } from '../../../../src/shared/execution-host/execution-host'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../src/shared/execution-host/execution-host'
import {
  folderIdOfSelector,
  folderWorkspaceKey
} from '../../../../src/shared/workspace/identity/workspace-scope'
import type { HostBotListing } from '../../bots/host-bot-listing'
import type { Worktree } from '../../worktree/workspace-list/workspace-list-types'

// A session's ⋯ Delete opens the host list's own delete confirm: the session leaves a one-shot
// intent here and goes to /h/<host>?deleteWorkspace=<token>. Only that navigation carries the token,
// so a list opened any other way, a deep link, or a reload never opens a delete.
export const HOST_LIST_DELETE_PARAM = 'deleteWorkspace'

// Measured from the tap, never restarted: a stalled hop or slow catalog must not open a delete later.
export const HOST_LIST_DELETE_INTENT_TTL_MS = 10_000

export type HostListDeleteTarget = {
  /** The paired desktop whose list owns the row. */
  hostId: string
  /** The checkout's own host on that desktop (local or an SSH target), from the session's record. */
  owner: ExecutionHostId
  worktreeId: string
}

/** A list's hold on an intent: valid only on the route it was taken on, until the tap's deadline. */
export type HostListDeleteClaim = HostListDeleteTarget & { deadline: number; pathname: string }

type PendingIntent = HostListDeleteTarget & { token: string; deadline: number }

let pending: PendingIntent | null = null
let issued = 0

/** Records the intent, replacing any earlier one, and returns the token its navigation must carry. */
export function requestHostListDelete(target: HostListDeleteTarget, now = Date.now()): string {
  issued += 1
  const token = `${issued.toString(36)}${Math.random().toString(36).slice(2, 10)}`
  pending = { ...target, token, deadline: now + HOST_LIST_DELETE_INTENT_TTL_MS }
  return token
}

/** Hands the intent to the first list that presents its token; any presented token spends it. */
export function takeHostListDeleteIntent(
  token: string,
  hostId: string,
  pathname: string,
  now = Date.now()
): HostListDeleteClaim | null {
  const intent = pending
  if (!token || intent === null || intent.token !== token) {
    return null
  }
  pending = null
  if (intent.hostId !== hostId || now > intent.deadline) {
    return null
  }
  return {
    hostId: intent.hostId,
    owner: intent.owner,
    worktreeId: intent.worktreeId,
    deadline: intent.deadline,
    pathname
  }
}

/** The one row the session showed: same id on the same checkout owner, never a same-id twin elsewhere. */
export function findHostListDeleteRow<Row extends Pick<Worktree, 'worktreeId' | 'hostId'>>(
  rows: readonly Row[],
  target: Pick<HostListDeleteTarget, 'owner' | 'worktreeId'>
): Row | null {
  const matches = rows.filter(
    (row) => row.worktreeId === target.worktreeId && row.hostId === target.owner
  )
  return matches.length === 1 ? matches[0] : null
}

/** This desktop's bot and group homes, or null while its bots are unread or unreadable. */
export function hostListBotHomes(listings: readonly HostBotListing[]): ReadonlySet<string> | null {
  const local = listings.find((listing) => listing.hostId === LOCAL_EXECUTION_HOST_ID)
  if (local?.kind === 'update-needed') {
    return new Set()
  }
  if (local?.kind !== 'listed') {
    return null
  }
  return new Set(
    [...local.bots, ...(local.groups ?? [])].map((home) =>
      folderWorkspaceKey(home.folderWorkspaceId)
    )
  )
}

/** Whether the list's own menu would offer Delete for this row; a folder waits until homes are known. */
export function admitsHostListDelete(
  row: Pick<Worktree, 'worktreeId' | 'botHome'>,
  homes: ReadonlySet<string> | null
): boolean | 'unknown' {
  if (row.botHome === true) {
    return false
  }
  if (folderIdOfSelector(row.worktreeId) === undefined) {
    return true
  }
  return homes === null ? 'unknown' : !homes.has(row.worktreeId)
}

export type HostListDeleteView<Row> = {
  /** A presented token, already spent from the store this pass. */
  token: string
  hostId: string | undefined
  pathname: string
  connected: boolean
  /** Another row's menu or confirm is open: the user is doing something else. */
  overlayBusy: boolean
  rows: readonly Row[]
  homes: ReadonlySet<string> | null
  now: number
}

export type HostListDeleteStep<Row> =
  | { kind: 'wait' }
  | { kind: 'open'; row: Row }
  | { kind: 'notFound' }
  | { kind: 'none' }

/** One pass of the list's claim: a new token replaces the held claim before any row is published,
 *  and the held claim opens only while still on its route, unanswered, within the tap's deadline. */
export function advanceHostListDeleteClaim<
  Row extends Pick<Worktree, 'worktreeId' | 'hostId' | 'botHome'>
>(
  held: HostListDeleteClaim | null,
  view: HostListDeleteView<Row>
): { claim: HostListDeleteClaim | null; step: HostListDeleteStep<Row> } {
  const claim =
    view.token && view.hostId
      ? takeHostListDeleteIntent(view.token, view.hostId, view.pathname, view.now)
      : held
  if (!claim) {
    return { claim: null, step: { kind: 'none' } }
  }
  if (claim.hostId !== view.hostId || claim.pathname !== view.pathname || view.overlayBusy) {
    return { claim: null, step: { kind: 'none' } }
  }
  if (view.now > claim.deadline) {
    return { claim: null, step: { kind: 'notFound' } }
  }
  // Last-known rows while reconnecting are not proof the checkout is still there.
  const row = view.connected ? findHostListDeleteRow(view.rows, claim) : null
  const admitted = row ? admitsHostListDelete(row, view.homes) : 'unknown'
  if (!row || admitted === 'unknown') {
    return { claim, step: { kind: 'wait' } }
  }
  return admitted
    ? { claim: null, step: { kind: 'open', row } }
    : { claim: null, step: { kind: 'notFound' } }
}

export function resetHostListDeleteIntentForTest(): void {
  pending = null
}
