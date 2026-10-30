import { toSshExecutionHostId } from '../../../../shared/execution-host'
import { UNVERIFIED_PROCESS_EXIT_CODE } from '../../../../shared/terminal-exit-cause'
import type { Store } from '../../../persistence'
import type { OrcaRuntimeService } from '../../../runtime/orca-runtime'
import { ptyIncarnationById, ptyOwnership } from '../provider/ownership-state'
import { clearProviderPtyState } from '../provider/state-cleanup'
import { retireReplacedPaneBinding } from './pane-owner-replacement'
import type { ReplacedPaneOwner } from './replaced-pane-owner'

type AbsentPaneContext = {
  runtime: OrcaRuntimeService | undefined
  store?: Store
  worktreeId?: string
  connectionId?: string | null
}
type AbsentPaneOwner = {
  tabId: string
  leafId: string
  ptyId: string
  incarnationId?: string
  runtimeIncarnationId?: string
  persistedIncarnationId?: string
}

// A newer incarnation of this id committed after the host's answer; it is not the absent process.
function isSupersededAbsentOwner(owner: AbsentPaneOwner): boolean {
  const liveIncarnationId = ptyIncarnationById.get(owner.ptyId)
  return liveIncarnationId !== undefined && liveIncarnationId !== owner.runtimeIncarnationId
}

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
): ReplacedPaneOwner & {
  pane: NonNullable<ReplacedPaneOwner['pane']>
  absenceFence: { incarnationId: string | undefined }
} {
  return {
    ptyId: owner.ptyId,
    absenceFence: { incarnationId: owner.persistedIncarnationId },
    pane: {
      worktreeId,
      tabId: owner.tabId,
      leafId: owner.leafId,
      hostId: connectionId ? toSshExecutionHostId(connectionId) : undefined
    }
  }
}

/** Clear only the proven-dead binding, preserving the pane; refuse when another owner won meanwhile. */
export async function releaseAbsentPaneOwner(
  context: AbsentPaneContext,
  owner: AbsentPaneOwner
): Promise<boolean> {
  const { runtime, store, worktreeId, connectionId } = context
  if (isSupersededAbsentOwner(owner)) {
    return false
  }
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

/** Keep the dead binding for one-write replacement; null means the caller must retire it normally. */
export function keepAbsentPaneBindingForSwap(
  context: AbsentPaneContext,
  owner: AbsentPaneOwner
): ReplacedPaneOwner | null {
  const { runtime, store, worktreeId, connectionId } = context
  if (!worktreeId || !store || isSupersededAbsentOwner(owner)) {
    return null
  }
  releaseAbsentPaneProcess(runtime, owner)
  return { ...absentPaneReplacement(worktreeId, connectionId, owner), dropsIncarnation: true }
}
