import { toSshExecutionHostId } from '../../../../shared/execution-host'
import { UNVERIFIED_PROCESS_EXIT_CODE } from '../../../../shared/terminal-exit-cause'
import type { Store } from '../../../persistence'
import type { OrcaRuntimeService } from '../../../runtime/orca-runtime'
import { ptyOwnership } from '../provider/ownership-state'
import { clearProviderPtyState } from '../provider/state-cleanup'
import { retireReplacedPaneBinding } from './pane-owner-replacement'
import type { ReplacedPaneOwner } from './replaced-pane-owner'

type AbsentPaneContext = {
  runtime: OrcaRuntimeService | undefined
  store?: Store
  worktreeId?: string
  connectionId?: string | null
}
type AbsentPaneOwner = { tabId: string; leafId: string; ptyId: string; incarnationId?: string }

/** Ends the dead process's in-memory state; its durable binding is the caller's to clear. */
function releaseAbsentPaneProcess(
  runtime: OrcaRuntimeService | undefined,
  owner: AbsentPaneOwner
): void {
  const settleStop = runtime?.intentionalPtyStops?.mark(
    owner.ptyId,
    'replaced',
    owner.incarnationId ?? null
  )
  runtime?.onPtyExit(owner.ptyId, UNVERIFIED_PROCESS_EXIT_CODE, owner.incarnationId, {
    hostExitConfirmed: true
  })
  settleStop?.(true)
  clearProviderPtyState(owner.ptyId)
  ptyOwnership.delete(owner.ptyId)
}

function absentPaneReplacement(
  worktreeId: string,
  connectionId: string | null | undefined,
  owner: AbsentPaneOwner
): ReplacedPaneOwner & { pane: NonNullable<ReplacedPaneOwner['pane']> } {
  return {
    ptyId: owner.ptyId,
    pane: {
      worktreeId,
      tabId: owner.tabId,
      leafId: owner.leafId,
      hostId: connectionId ? toSshExecutionHostId(connectionId) : undefined
    }
  }
}

/**
 * The owning host answered that the pane's process is gone. The pane outlives it: a fresh spawn
 * replaces the process, so only the dead id's binding is cleared. False when another owner took
 * the pane meanwhile.
 */
export async function releaseAbsentPaneOwner(
  context: AbsentPaneContext,
  owner: AbsentPaneOwner
): Promise<boolean> {
  const { runtime, store, worktreeId, connectionId } = context
  releaseAbsentPaneProcess(runtime, owner)
  if (!worktreeId) {
    return true
  }
  // Without the Store the binding cannot be cleared, so the pane is not free for a fresh spawn.
  if (!store) {
    return false
  }
  return retireReplacedPaneBinding(store, absentPaneReplacement(worktreeId, connectionId, owner))
}

/**
 * As releaseAbsentPaneOwner, but the dead binding stays for the fresh spawn's bind to swap in one
 * write. Null when that swap cannot happen here, so the caller retires as before.
 */
export function keepAbsentPaneBindingForSwap(
  context: AbsentPaneContext,
  owner: AbsentPaneOwner
): ReplacedPaneOwner | null {
  const { runtime, store, worktreeId, connectionId } = context
  if (!worktreeId || !store) {
    return null
  }
  releaseAbsentPaneProcess(runtime, owner)
  return { ...absentPaneReplacement(worktreeId, connectionId, owner), dropsIncarnation: true }
}
