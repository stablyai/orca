import { toSshExecutionHostId } from '../../../shared/execution-host'
import type { SshRemotePtyLease } from '../../../shared/ssh-types'
import { isTerminalLeafId } from '../../../shared/stable-pane-id'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import type { SshPtyLeaseOperations } from './ssh-pty-lease-operations'

/**
 * Every PTY id any partition binds to this pane, most authoritative first.
 *
 * Keyed on the leaf alone — the only remint-stable half of a pane key, since
 * `detachTerminalPaneToTab` moves a live pane and leaves its lease naming the tab it left.
 *
 * Returns a LIST, and reads the target's own partition first, because the two partitions disagree
 * for the length of a reconnect and this resolved that disagreement backwards. Main writes an SSH
 * pane's binding to `ssh:<target>`, while a stale copy of the same leaf survives in `local`;
 * consulting `local` first therefore named the PREDECESSOR as the pane's current PTY on every relay
 * restart. Supersession then took that expired predecessor as its winner and returned without
 * marking anything — the per-reconnect lease growth. Both partitions are still read, because a
 * reader that consulted only one would see "unbound" for a live pane and expire its lease.
 */
function durablyBoundPtyIdsForPane(
  operations: SshPtyLeaseOperations,
  targetId: string,
  leafId: string
): string[] {
  const findLeafBindings = (session: WorkspaceSessionState | undefined): string[] =>
    Object.values(session?.terminalLayoutsByTabId ?? {})
      .map((layout) => layout?.ptyIdsByLeafId?.[leafId])
      .filter((ptyId): ptyId is string => Boolean(ptyId))
  const ordered = [
    ...findLeafBindings(
      operations.state.workspaceSessionsByHostId?.[toSshExecutionHostId(targetId)]
    ),
    ...findLeafBindings(operations.state.workspaceSession)
  ]
  return [...new Set(ordered.map((ptyId) => operations.toComparablePtyId(targetId, ptyId)))]
}

/** A lease this client still holds a route to, as opposed to one it has already lost. */
function isLiveLeaseState(state: SshRemotePtyLease['state']): boolean {
  return state === 'attached' || state === 'detached'
}

/**
 * One pane owns at most one live remote PTY. Lease identity is `(targetId, ptyId)` alone, so a
 * pane re-leasing under a new relay id leaves its predecessor live with nothing to retire it and
 * the next reattach fans out over both — the reported 2 -> 19 -> 20 across three reconnects.
 *
 * Superseded leases are marked `expired`, never `terminated`: losing a lease is not evidence the
 * shell died, so the remote process is deliberately left running. They also carry `supersededBy`,
 * which is what keeps them out of the bulk reattach set now that plain `expired` no longer does —
 * the winner's ptyId is already in hand here, so recording it needs no relay-start identity.
 */
export function supersedeSiblingLeasesForPane(
  operations: SshPtyLeaseOperations,
  winner: SshRemotePtyLease,
  now: number
): boolean {
  if (!winner.worktreeId || !winner.leafId) {
    return false
  }
  if (winner.state === 'terminated' || winner.state === 'expired') {
    return false
  }
  // At upsert time the arriving lease may not be the one the pane is bound to yet. Expiring the
  // bound predecessor would detach a live pane, so leave both live and let reattach arbitrate
  // with the binding in hand. `supersedeSshRemotePtyLeasesForBoundPane` re-runs this once the
  // binding write lands, so a caller that upserts before it binds is not left bailed forever.
  // Membership rather than equality: during a reconnect the two partitions name different PTYs for
  // the same leaf, and requiring the winner to match the FIRST one read is what made this bail.
  const boundPtyIds = durablyBoundPtyIdsForPane(operations, winner.targetId, winner.leafId)
  if (boundPtyIds.length > 0 && !boundPtyIds.includes(winner.ptyId)) {
    return false
  }
  let marked = false
  const superseded: SshRemotePtyLease[] = []
  for (const lease of operations.state.sshRemotePtyLeases ?? []) {
    if (
      lease.ptyId === winner.ptyId ||
      lease.targetId !== winner.targetId ||
      lease.worktreeId !== winner.worktreeId ||
      // Leaf only: a lease freezes its tabId, so a pane broken out into a new tab would otherwise
      // never compete with its own predecessor — which is the reported cardinality growth.
      lease.leafId !== winner.leafId ||
      lease.state === 'terminated' ||
      // Never retire a shell the pane is BOTH still bound to and still routable to. The stale
      // partition can name a predecessor, and retiring that is the point; retiring a live one
      // would strand a running remote process behind a pane that can no longer reach it.
      (boundPtyIds.includes(lease.ptyId) && isLiveLeaseState(lease.state))
    ) {
      continue
    }
    if (lease.state === 'expired') {
      // An already-expired predecessor is superseded by the same evidence, and marking it is what
      // bounds the reattach set: without this, every past orphan for this pane stays reattachable
      // forever. `updatedAt` stays put — bumping it would make a stale lease look recent to
      // `getRecentExpiredSshLease`.
      marked ||= lease.supersededBy !== winner.ptyId
      lease.supersededBy = winner.ptyId
      continue
    }
    lease.state = 'expired'
    lease.supersededBy = winner.ptyId
    lease.updatedAt = now
    marked = true
    superseded.push(lease)
  }
  if (superseded.length > 0) {
    // Why: matching on lease ptyId first means this scrubs only the predecessor's stale binding —
    // the winner's own binding cannot match and is left intact.
    operations.clearBindingsForLeases(winner.targetId, superseded)
  }
  return marked
}

/**
 * Supersede from the lease the pane's binding names — preferring a LIVE one when the partitions
 * disagree, since a reconnect leaves the stale partition naming an already-expired predecessor and
 * an expired winner supersedes nothing.
 */
function supersedeFromBoundPane(
  operations: SshPtyLeaseOperations,
  targetId: string,
  leafId: string,
  now: number
): boolean {
  if (!isTerminalLeafId(leafId)) {
    return false
  }
  const boundPtyIds = durablyBoundPtyIdsForPane(operations, targetId, leafId)
  if (boundPtyIds.length === 0) {
    // No binding names this pane, so nothing here is evidence about which shell owns it. Leaving
    // every lease reattachable is the deliberate direction: an orphan must stay askable.
    return false
  }
  const candidates = (operations.state.sshRemotePtyLeases ?? []).filter(
    (lease) =>
      lease.targetId === targetId && lease.leafId === leafId && boundPtyIds.includes(lease.ptyId)
  )
  const winner = candidates.find((lease) => isLiveLeaseState(lease.state))
  const marked = winner ? supersedeSiblingLeasesForPane(operations, winner, now) : false
  return marked
}

/**
 * The binding-side trigger for supersession, and the reason the two writes that together claim a
 * pane are commutative.
 *
 * `upsertSshRemotePtyLease` is the only other trigger, and it bails whenever the pane's durable
 * binding still names the predecessor. A spawn path that upserts its lease BEFORE it writes the
 * binding therefore bails and never re-runs on its own. Re-resolving the winner from the binding
 * is safe in the other direction too: it supersedes only from the lease the pane is actually bound
 * to, so it can never strand a live orphan.
 */
export function supersedeSshRemotePtyLeasesForBoundPane(
  operations: SshPtyLeaseOperations,
  targetId: string,
  leafId: string
): void {
  if (supersedeFromBoundPane(operations, targetId, leafId, Date.now())) {
    operations.flush()
  }
}

/**
 * Bound the reattach set to one lease per pane, re-derived from each pane's CURRENT binding.
 *
 * The spawn-side trigger cannot be sufficient alone, and measuring the shipped path is what showed
 * it: a pane's binding has several writers — the spawn commit, the relay's reattach bind, and the
 * renderer's debounced layout publish — and the last of those lands well after the spawn commit
 * that leased the pty. A predecessor that was still bound when its successor was claimed therefore
 * keeps its reattachability forever, because nothing revisits it once the binding catches up. The
 * observed rows agreed on target, worktree, tab and leaf and still carried no mark.
 *
 * Running this immediately before the reattach set is read makes the answer independent of which
 * writer bound the pane and when. It also repairs stores written by earlier builds, where these
 * rows have already accumulated and no spawn-time trigger would ever revisit them.
 *
 * Panes with no binding are skipped rather than pruned: absence of a binding is not evidence about
 * which shell owns the pane, and a genuine orphan has to stay askable
 * (docs/reference/ssh-execution-boundary.md).
 */
export function reconcileSshRemotePtyLeasesForTarget(
  operations: SshPtyLeaseOperations,
  targetId: string
): void {
  const leafIds = new Set<string>()
  for (const lease of operations.state.sshRemotePtyLeases ?? []) {
    if (lease.targetId === targetId && lease.leafId) {
      leafIds.add(lease.leafId)
    }
  }
  const now = Date.now()
  let changed = false
  for (const leafId of leafIds) {
    changed = supersedeFromBoundPane(operations, targetId, leafId, now) || changed
  }
  if (changed) {
    operations.flush()
  }
}
