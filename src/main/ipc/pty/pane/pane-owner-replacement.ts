import { toSshExecutionHostId } from '../../../../shared/execution-host'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import type { Store } from '../../../persistence'
import type { PersistPtyBindingArgs } from '../../../persistence/loading-store/pty-binding-persistence'
import type { OrcaRuntimeService } from '../../../runtime/orca-runtime'
import type { ReplacedPaneOwner } from './replaced-pane-owner'
import { resolveStablePaneOwner } from './stable-owner'

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

/**
 * The replacement's bind is the swap: decided inside the bind's durable mutation, it takes a leaf
 * still naming the stopped id, or one the renderer already cleared; any other owner wins.
 */
export function swapReplacedPaneBinding(
  store: Store,
  binding: PersistPtyBindingArgs,
  replaced: ReplacedPaneOwner
): () => PersistPtyBindingArgs | null {
  return () => {
    const bound =
      store.getWorkspaceSession().terminalLayoutsByTabId?.[binding.tabId]?.ptyIdsByLeafId?.[
        binding.leafId
      ]
    // Unbound is ok: the renderer's pre-connect clear can withdraw it (split tab).
    if (bound !== undefined && bound !== replaced.ptyId) {
      return null
    }
    return replaced.dropsIncarnation ? { ...binding, dropsIncarnation: true } : binding
  }
}

/** Clears a stopped id's binding and keeps the pane; false when another owner took the pane. */
export async function retireReplacedPaneBinding(
  store: Store,
  replaced: ReplacedPaneOwner & {
    pane: NonNullable<ReplacedPaneOwner['pane']>
    /** Also fence on the saved incarnation, for an id the host reported absent rather than stopped. */
    absenceFence?: { incarnationId: string | undefined }
  }
): Promise<boolean> {
  const { hostId, ...pane } = replaced.pane
  return store.retirePtyBinding({ ...pane, ptyId: replaced.ptyId }, hostId, replaced.absenceFence)
}

/** Best effort: a failed replacement must not leave the stopped id bound for the remount to reattach. */
export async function releaseStoppedPaneBinding(
  store: Store | undefined,
  replaced: ReplacedPaneOwner
): Promise<void> {
  if (!store || !replaced.pane) {
    return
  }
  try {
    await retireReplacedPaneBinding(store, { ...replaced, pane: replaced.pane })
  } catch (error) {
    console.warn('[pty] could not clear the stopped pane binding after a failed restart:', error)
  }
}
