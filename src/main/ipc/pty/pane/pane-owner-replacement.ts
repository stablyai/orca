import { toSshExecutionHostId } from '../../../../shared/execution-host'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import type { Store } from '../../../persistence'
import type { PersistPtyBindingArgs } from '../../../persistence/loading-store/pty-binding-persistence'
import type { OrcaRuntimeService } from '../../../runtime/orca-runtime'
import { resolveStablePaneOwner, type StablePaneOwner } from './stable-owner'

/** The owner a replacing spawn stopped. Its binding stays until the replacement's bind swaps it. */
export type ReplacedPaneOwner = {
  ptyId: string
  pane: { worktreeId: string; tabId: string; leafId: string; hostId: string | undefined } | null
}

/** Caller holds the pane's spawn reservation, so no other spawn can claim the pane meanwhile. */
export async function stopReplacedPaneOwner(
  deps: {
    runtime?: OrcaRuntimeService
    store?: Store
    stopReplacedPty: (id: string) => Promise<void>
  },
  args: {
    replacesPtyId: string
    paneKey: string | null
    worktreeId: string | undefined
    connectionId: string | null | undefined
  }
): Promise<ReplacedPaneOwner> {
  const owner = resolveStablePaneOwner(
    deps.runtime,
    deps.store,
    args.paneKey,
    args.worktreeId,
    args.connectionId
  )
  if (owner && owner.ptyId !== args.replacesPtyId) {
    throw new Error('terminal_pane_owner_changed')
  }
  await deps.stopReplacedPty(args.replacesPtyId)
  const pane = args.paneKey ? parsePaneKey(args.paneKey) : null
  return {
    ptyId: args.replacesPtyId,
    pane:
      pane && args.worktreeId
        ? {
            worktreeId: args.worktreeId,
            tabId: pane.tabId,
            leafId: pane.leafId,
            hostId: args.connectionId ? toSshExecutionHostId(args.connectionId) : undefined
          }
        : null
  }
}

/** The stopped id is dead whatever its incarnation, so a binding naming it must not be reattached. */
export function excludeReplacedPaneOwner(
  owner: StablePaneOwner | null,
  replaced: ReplacedPaneOwner | null
): StablePaneOwner | null {
  return owner && owner.ptyId === replaced?.ptyId ? null : owner
}

/**
 * The replacement's bind is the swap: decided inside the bind's durable mutation, it takes a leaf
 * still naming the stopped id, or one the renderer already cleared; any other owner wins.
 */
export function swapReplacedPaneBinding(
  store: Store,
  binding: PersistPtyBindingArgs,
  replaced: ReplacedPaneOwner,
  hostId: string | undefined
): () => PersistPtyBindingArgs | null {
  return () => {
    const bound =
      store.getWorkspaceSession(hostId).terminalLayoutsByTabId?.[binding.tabId]?.ptyIdsByLeafId?.[
        binding.leafId
      ]
    // Unbound is ok: the renderer's pre-connect clear can withdraw it (split tab, SSH lease ended).
    return bound === undefined || bound === replaced.ptyId ? binding : null
  }
}

/** Best effort: a failed replacement must not leave the stopped id bound for the remount to reattach. */
export async function releaseStoppedPaneBinding(
  store: Store | undefined,
  replaced: ReplacedPaneOwner
): Promise<void> {
  if (!store || !replaced.pane) {
    return
  }
  const { hostId, ...pane } = replaced.pane
  try {
    await store.retirePtyBinding({ ...pane, ptyId: replaced.ptyId }, hostId)
  } catch (error) {
    console.warn('[pty] could not clear the stopped pane binding after a failed restart:', error)
  }
}
