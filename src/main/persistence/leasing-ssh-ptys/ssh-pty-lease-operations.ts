import { toSshExecutionHostId } from '../../../shared/execution-host'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { SshRemotePtyLease } from '../../../shared/ssh-types'
import { isTerminalLeafId } from '../../../shared/stable-pane-id'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { invalidateLocalWorktreeMetadataPruneInputs } from '../../local-worktree-metadata-prune-gate'

export type SshPtyLeaseOperations = {
  state: PersistedState
  toStoredPtyId: (targetId: string, ptyId: string) => string
  toComparablePtyId: (targetId: string, ptyId: string) => string
  clearBindingsForTarget: (targetId: string) => void
  clearBindingsForLeases: (targetId: string, leases: SshRemotePtyLease[]) => boolean
  flush: () => void
  flushDurableStateOrThrowAsync: () => Promise<void>
}

/**
 * The PTY a pane is durably bound to, keyed on the leaf alone — the only remint-stable half of a
 * pane key, since `detachTerminalPaneToTab` moves a live pane and leaves its lease naming the tab
 * it left.
 *
 * Reads both partitions deliberately. Main writes some SSH pane bindings to `ssh:<target>` and
 * some to `local`, so a reader that consulted one would see "unbound" for a live pane and expire
 * its lease. Reading both makes this fence correct whichever partition the binding landed in.
 */
function durablyBoundPtyIdForPane(
  operations: SshPtyLeaseOperations,
  targetId: string,
  leafId: string
): string | undefined {
  const findLeafBinding = (session: WorkspaceSessionState | undefined): string | undefined =>
    Object.values(session?.terminalLayoutsByTabId ?? {}).find(
      (layout) => layout?.ptyIdsByLeafId?.[leafId]
    )?.ptyIdsByLeafId?.[leafId]
  const boundPtyId =
    findLeafBinding(operations.state.workspaceSession) ??
    findLeafBinding(operations.state.workspaceSessionsByHostId?.[toSshExecutionHostId(targetId)])
  return boundPtyId ? operations.toComparablePtyId(targetId, boundPtyId) : undefined
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
function supersedeSiblingLeasesForPane(
  operations: SshPtyLeaseOperations,
  winner: SshRemotePtyLease,
  now: number
): void {
  if (!winner.worktreeId || !winner.leafId) {
    return
  }
  if (winner.state === 'terminated' || winner.state === 'expired') {
    return
  }
  // At upsert time the arriving lease may not be the one the pane is bound to yet. Expiring the
  // bound predecessor would detach a live pane, so leave both live and let reattach arbitrate
  // with the binding in hand.
  const boundPtyId = durablyBoundPtyIdForPane(operations, winner.targetId, winner.leafId)
  if (boundPtyId && boundPtyId !== winner.ptyId) {
    return
  }
  const superseded: SshRemotePtyLease[] = []
  for (const lease of operations.state.sshRemotePtyLeases ?? []) {
    if (
      lease.ptyId === winner.ptyId ||
      lease.targetId !== winner.targetId ||
      lease.worktreeId !== winner.worktreeId ||
      // Leaf only: a lease freezes its tabId, so a pane broken out into a new tab would otherwise
      // never compete with its own predecessor — which is the reported cardinality growth.
      lease.leafId !== winner.leafId ||
      lease.state === 'terminated'
    ) {
      continue
    }
    if (lease.state === 'expired') {
      // An already-expired predecessor is superseded by the same evidence, and marking it is what
      // bounds the reattach set: without this, every past orphan for this pane stays reattachable
      // forever. `updatedAt` stays put — bumping it would make a stale lease look recent to
      // `getRecentExpiredSshLease`.
      lease.supersededBy = winner.ptyId
      continue
    }
    lease.state = 'expired'
    lease.supersededBy = winner.ptyId
    lease.updatedAt = now
    superseded.push(lease)
  }
  if (superseded.length > 0) {
    // Why: matching on lease ptyId first means this scrubs only the predecessor's stale binding —
    // the winner's own binding cannot match and is left intact.
    operations.clearBindingsForLeases(winner.targetId, superseded)
  }
}

/**
 * Only `terminated` unbinds a pane. It is the operator-close state and the one written after a
 * host-acknowledged stop; `expired` records that the CLIENT lost its route and says nothing about
 * the remote shell (docs/reference/ssh-execution-boundary.md). Wiping the binding on `expired` made
 * `resolvePersistedStablePaneOwner` return null, so `adoptStablePane` gave up and `createTerminal`
 * spawned a replacement over a process that was still running. Keeping it buys a reattach ATTEMPT
 * only — a genuinely dead shell is retired by `attachStablePaneOwner` on the relay's own absence
 * answer, which then falls through to a fresh spawn.
 *
 * Supersession is the one place `expired` still scrubs a binding, and it does so explicitly in
 * `supersedeSiblingLeasesForPane`: there a NEWER lease for the same pane is the evidence.
 */
function leaseStateWithdrawsBinding(state: SshRemotePtyLease['state']): boolean {
  return state === 'terminated'
}

export function getSshRemotePtyLeases(
  state: PersistedState,
  targetId?: string
): SshRemotePtyLease[] {
  const leases = state.sshRemotePtyLeases ?? []
  return leases.filter((lease) => targetId === undefined || lease.targetId === targetId)
}

export function upsertSshRemotePtyLease(
  operations: SshPtyLeaseOperations,
  lease: Omit<SshRemotePtyLease, 'createdAt' | 'updatedAt'> &
    Partial<Pick<SshRemotePtyLease, 'createdAt' | 'updatedAt'>>
): void {
  operations.state.sshRemotePtyLeases ??= []
  const normalizedLease = { ...lease }
  if (normalizedLease.leafId !== undefined && !isTerminalLeafId(normalizedLease.leafId)) {
    delete normalizedLease.leafId
  }
  // Why: store target-local pty ids in leases so reconnect can call relay pty.attach with raw ids (app ids are global).
  normalizedLease.ptyId = operations.toStoredPtyId(normalizedLease.targetId, normalizedLease.ptyId)
  const now = Date.now()
  const existingIndex = operations.state.sshRemotePtyLeases.findIndex(
    (entry) => entry.targetId === normalizedLease.targetId && entry.ptyId === normalizedLease.ptyId
  )
  const existing =
    existingIndex !== -1 ? operations.state.sshRemotePtyLeases[existingIndex] : undefined
  // NOTE: a relay numbers its PTYs from `pty-1` on every start, so after a relay restart this
  // match can be an id RECYCLED onto a different shell rather than the same lease. When the
  // caller names its own pane the merge below overwrites the stale identity; when it omits those
  // fields (both spawn callers do, conditionally) the stale pane survives. Distinguishing the two
  // needs a relay-start identity the lease does not carry — see STA-3077 notes before adding one.
  // Why: callers pass optional fields as explicit `undefined`, which would blank the stored tabId/leafId
  // (and friends) when re-upserting an existing lease.
  const definedLease = Object.fromEntries(
    Object.entries(normalizedLease).filter(([, value]) => value !== undefined)
  ) as typeof normalizedLease
  const next: SshRemotePtyLease = {
    ...existing,
    ...definedLease,
    createdAt: existing?.createdAt ?? normalizedLease.createdAt ?? now,
    updatedAt: normalizedLease.updatedAt ?? now
  }
  // A relay renumbers from `pty-1` on every start, so `existing` can be a RECYCLED id. Route
  // retirement belongs to the shell that lost, never to whatever claims the id next — drop both
  // marks the moment this id is claimed live again, and let supersession re-derive them below.
  if (next.state === 'attached' || next.state === 'detached') {
    delete next.supersededBy
    delete next.relayIdRecycled
  }
  if (existingIndex !== -1) {
    operations.state.sshRemotePtyLeases[existingIndex] = next
  } else {
    operations.state.sshRemotePtyLeases.push(next)
  }
  supersedeSiblingLeasesForPane(operations, next, now)
  operations.flush()
}

function updateSshRemotePtyLeaseStates(
  operations: SshPtyLeaseOperations,
  targetId: string,
  state: SshRemotePtyLease['state'],
  ptyIds?: ReadonlySet<string>
): boolean {
  const now = Date.now()
  let changed = false
  const shouldClearBindings = leaseStateWithdrawsBinding(state)
  const leasesToClear: SshRemotePtyLease[] = []
  operations.state.sshRemotePtyLeases ??= []
  for (const lease of operations.state.sshRemotePtyLeases) {
    if (lease.targetId !== targetId || (ptyIds && !ptyIds.has(lease.ptyId))) {
      continue
    }
    if (state === 'attached' && lease.state === 'terminated') {
      continue
    }
    // `expired` says the CLIENT lost its route, never that the shell died - and a reattach that
    // named this exact pty and succeeded is the one thing that can settle which it was. Without
    // this edge a lease that proved itself alive stayed `expired` for good, which silently exempted
    // a running remote shell from `ssh:reset`, from the SSH_TERMINATE_RECONNECT_REQUIRED fence in
    // `ssh:terminateSessions`, and from the quit-time `detached` sweep, and left it unable to win
    // supersession so its own successors never retired their predecessors.
    // Only the id-qualified caller (`markSshRemotePtyLeasesAttachedAsync`, fed by the relay's
    // `attachedLeaseIds`) carries that proof; a bulk mark over a whole target does not.
    if (state === 'attached' && lease.state === 'expired' && !ptyIds) {
      continue
    }
    if (state === 'detached' && lease.state !== 'attached') {
      continue
    }
    if (lease.state !== state) {
      const reclaimed = state === 'attached' && lease.state === 'expired'
      lease.state = state
      lease.updatedAt = now
      if (state === 'attached') {
        lease.lastAttachedAt = now
      } else if (state === 'detached') {
        lease.lastDetachedAt = now
      }
      if (reclaimed) {
        // Route retirement belongs to the shell that lost the pane. This lease just proved it is
        // that shell, so `attached` may never carry a supersession mark - the same invariant
        // `upsertSshRemotePtyLease` enforces when an id is claimed live again.
        delete lease.supersededBy
        delete lease.relayIdRecycled
      }
      changed = true
    }
    if (shouldClearBindings) {
      leasesToClear.push(lease)
    }
  }
  const bindingsChanged = shouldClearBindings
    ? operations.clearBindingsForLeases(targetId, leasesToClear)
    : false
  return changed || bindingsChanged
}

export function markSshRemotePtyLeases(
  operations: SshPtyLeaseOperations,
  targetId: string,
  state: SshRemotePtyLease['state']
): void {
  if (updateSshRemotePtyLeaseStates(operations, targetId, state)) {
    operations.flush()
  }
}

// Why no write of its own: the committed quit path calls this immediately before the final store
// flush, and that flush is what persists it. A durable write here would race the flush and be
// rejected the moment it latches, which is exactly how an attached lease used to survive quit.
export function markSshRemotePtyLeasesForShutdown(
  operations: SshPtyLeaseOperations,
  targetId: string,
  state: SshRemotePtyLease['state']
): void {
  updateSshRemotePtyLeaseStates(operations, targetId, state)
}

export async function markSshRemotePtyLeasesAsync(
  operations: SshPtyLeaseOperations,
  targetId: string,
  state: SshRemotePtyLease['state']
): Promise<void> {
  if (updateSshRemotePtyLeaseStates(operations, targetId, state)) {
    await operations.flushDurableStateOrThrowAsync()
  }
}

export async function markSshRemotePtyLeasesAttachedAsync(
  operations: SshPtyLeaseOperations,
  targetId: string,
  ptyIds: readonly string[]
): Promise<void> {
  const relayPtyIds = new Set(ptyIds.map((ptyId) => operations.toStoredPtyId(targetId, ptyId)))
  if (updateSshRemotePtyLeaseStates(operations, targetId, 'attached', relayPtyIds)) {
    await operations.flushDurableStateOrThrowAsync()
  }
}

/** `relayIdRecycled` is the pending-stop replay's evidence that the host now lists this id under a
 *  different incarnation. It is set here rather than inferred, because nothing downstream can
 *  re-derive it, and it must land even when the lease is already `expired`. */
export type MarkSshRemotePtyLeaseOptions = { relayIdRecycled?: true }

export function markSshRemotePtyLease(
  operations: SshPtyLeaseOperations,
  targetId: string,
  ptyId: string,
  state: SshRemotePtyLease['state'],
  options?: MarkSshRemotePtyLeaseOptions
): void {
  const relayPtyId = operations.toStoredPtyId(targetId, ptyId)
  const lease = operations.state.sshRemotePtyLeases?.find(
    (entry) => entry.targetId === targetId && entry.ptyId === relayPtyId
  )
  if (!lease) {
    return
  }
  const recycledChanged = options?.relayIdRecycled === true && lease.relayIdRecycled !== true
  if (recycledChanged) {
    lease.relayIdRecycled = true
  }
  const shouldClearBindings = leaseStateWithdrawsBinding(state)
  if (lease.state === state) {
    if (
      (shouldClearBindings && operations.clearBindingsForLeases(targetId, [lease])) ||
      recycledChanged
    ) {
      operations.flush()
    }
    return
  }
  const now = Date.now()
  lease.state = state
  lease.updatedAt = now
  if (state === 'attached') {
    lease.lastAttachedAt = now
  } else if (state === 'detached') {
    lease.lastDetachedAt = now
  }
  if (shouldClearBindings) {
    operations.clearBindingsForLeases(targetId, [lease])
  }
  operations.flush()
}

export function removeSshRemotePtyLease(
  operations: SshPtyLeaseOperations,
  targetId: string,
  ptyId: string
): void {
  const relayPtyId = operations.toStoredPtyId(targetId, ptyId)
  const leases = (operations.state.sshRemotePtyLeases ?? []).filter(
    (lease) => lease.targetId === targetId && lease.ptyId === relayPtyId
  )
  const before = operations.state.sshRemotePtyLeases?.length ?? 0
  operations.clearBindingsForLeases(targetId, leases)
  operations.state.sshRemotePtyLeases = (operations.state.sshRemotePtyLeases ?? []).filter(
    (lease) => lease.targetId !== targetId || lease.ptyId !== relayPtyId
  )
  if (operations.state.sshRemotePtyLeases.length !== before) {
    // Why: the lease may have been the last claim on a dangling metadata row (#17775).
    invalidateLocalWorktreeMetadataPruneInputs()
    operations.flush()
  }
}

export function removeSshRemotePtyLeases(
  operations: SshPtyLeaseOperations,
  targetId: string
): void {
  operations.state.sshRemotePtyLeases ??= []
  operations.clearBindingsForTarget(targetId)
  const before = operations.state.sshRemotePtyLeases.length
  operations.state.sshRemotePtyLeases = operations.state.sshRemotePtyLeases.filter(
    (lease) => lease.targetId !== targetId
  )
  if (operations.state.sshRemotePtyLeases.length !== before) {
    // Why: the leases may have been the last claim on dangling metadata rows (#17775).
    invalidateLocalWorktreeMetadataPruneInputs()
    operations.flush()
  }
}
