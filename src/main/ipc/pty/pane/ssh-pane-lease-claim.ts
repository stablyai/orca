import { isTerminalLeafId } from '../../../../shared/stable-pane-id'
import { getRelayPtyId } from '../provider/registry'
import type { Store } from '../../../persistence'

/**
 * Claim a remote PTY for a pane: record the lease, then retire the pane's predecessors.
 *
 * The lease keeps the RELAY id, because reconnect calls `pty.attach` with target-local ids, while
 * the pane binding keeps the app-facing id used for hydration.
 *
 * Supersession is a second step rather than something `upsertSshRemotePtyLease` finishes on its own
 * because it is fenced on the pane's durable binding — it refuses to retire a predecessor the pane
 * is still bound to, which would detach a live pane. A caller that leases BEFORE it binds therefore
 * trips that fence on every reconnect and, with the upsert as the only trigger, never re-runs: one
 * more reattachable lease, and one more `pty.attach` round trip on every later connect, forever.
 * Re-running it here from the binding side is what makes the two writes commute.
 */
export function claimSshPaneLease(args: {
  store: Store | undefined
  connectionId: string | null | undefined
  ptyId: string
  worktreeId: string | undefined
  tabId: string | undefined
  leafId: string | undefined
}): void {
  const { store, connectionId } = args
  if (!store || !connectionId) {
    return
  }
  const leafId =
    typeof args.leafId === 'string' && isTerminalLeafId(args.leafId) ? args.leafId : null
  store.upsertSshRemotePtyLease({
    targetId: connectionId,
    ptyId: getRelayPtyId(connectionId, args.ptyId),
    ...(typeof args.worktreeId === 'string' ? { worktreeId: args.worktreeId } : {}),
    ...(typeof args.tabId === 'string' ? { tabId: args.tabId } : {}),
    ...(leafId ? { leafId } : {}),
    state: 'attached',
    lastAttachedAt: Date.now()
  })
  if (leafId) {
    store.supersedeSshRemotePtyLeasesForBoundPane(connectionId, leafId)
  }
}
