import { PaneOwnerContentionError } from './pane-spawn-operation'
import {
  isDaemonEndpointGoneError,
  SessionNotFoundError,
  TerminalHostGoneError,
  TerminalSessionOwnerUnverifiedError
} from '../../../daemon/daemon-errors'
import type { PtySpawnResult } from '../../../providers/pty-provider-contract'
import { keepAbsentPaneBindingForSwap, releaseAbsentPaneOwner } from './absent-pane-owner'
import { excludeReplacedPaneOwner } from './replaced-pane-owner'
import { PANE_NOT_LIVE_ERROR } from '../../../../shared/pane-attach-only-view'
import type { StablePaneOwner, StablePaneSpawnContext } from './stable-owner'

type StablePaneAttachAttempt =
  | { attached: { result: PtySpawnResult; owner: StablePaneOwner } }
  | { absent: true }
  | { lostTo: StablePaneOwner | null }

function isSameStablePaneOwner(a: StablePaneOwner, b: StablePaneOwner): boolean {
  return (
    a.ptyId === b.ptyId &&
    a.runtimeIncarnationId === b.runtimeIncarnationId &&
    a.hasPersistedBinding === b.hasPersistedBinding &&
    a.persistedIncarnationId === b.persistedIncarnationId
  )
}

export async function attemptStablePaneAttach(
  args: StablePaneSpawnContext & { owner: StablePaneOwner }
): Promise<StablePaneAttachAttempt> {
  const { owner, provider, spawnOptions } = args
  let result: PtySpawnResult
  try {
    result = await provider.spawn({
      ...spawnOptions,
      sessionId: owner.ptyId,
      attachOnly: true,
      expectedIncarnationId: owner.runtimeIncarnationId ?? owner.persistedIncarnationId,
      expectedIncarnationIsAuthoritative: owner.runtimeIncarnationId !== undefined,
      isNewSession: undefined,
      command: undefined,
      commandDelivery: undefined,
      startupCommandDelivery: undefined,
      launchAgent: undefined,
      startupIngress: undefined,
      agentSessionEnsure: undefined,
      agentSessionCreateOperationId: undefined,
      onPtySpawnCommitted: undefined
    })
  } catch (error) {
    if (error instanceof TerminalSessionOwnerUnverifiedError) {
      throw new Error('terminal_pane_owner_unverified')
    }
    // Preserve endpoint-loss meaning before paired RPC strips socket code/syscall.
    if (isDaemonEndpointGoneError(error)) {
      throw new TerminalHostGoneError()
    }
    // Only typed absence from the owning registry authorizes retiring the process.
    if (!(error instanceof SessionNotFoundError)) {
      throw error
    }
    const ownerBeforeRetire = args.resolveOwner?.()
    if (ownerBeforeRetire && !isSameStablePaneOwner(ownerBeforeRetire, owner)) {
      return { lostTo: ownerBeforeRetire }
    }
    if (args.attachOnlyView) {
      // Main-started views reuse the bound ID and its terminal history.
      throw new Error(PANE_NOT_LIVE_ERROR)
    }
    // The adoption holds the pane's reservation, so its fresh bind can swap the dead binding.
    const kept = args.keepAbsentBinding ? keepAbsentPaneBindingForSwap(args, owner) : null
    if (kept) {
      args.keepAbsentBinding?.(kept)
    } else if (!(await releaseAbsentPaneOwner(args, owner))) {
      return { lostTo: args.resolveOwner?.() ?? null }
    }
    const ownerAfterRetire = excludeReplacedPaneOwner(args.resolveOwner?.() ?? null, kept)
    return ownerAfterRetire ? { lostTo: ownerAfterRetire } : { absent: true }
  }
  if (
    result.id !== owner.ptyId ||
    result.isReattach !== true ||
    (owner.runtimeIncarnationId !== undefined &&
      result.incarnationId !== owner.runtimeIncarnationId) ||
    (result.incarnationId === undefined && owner.incarnationId !== undefined)
  ) {
    throw new Error('terminal_pane_owner_changed')
  }
  return { attached: { result, owner } }
}

export async function reconcilePaneOwner<T>(args: {
  owner: StablePaneOwner | null
  resolveOwner: () => StablePaneOwner | null
  attach: (owner: StablePaneOwner) => Promise<T | null>
  fresh: () => Promise<T>
  losses?: number
}): Promise<T> {
  let owner = args.owner
  let losses = args.losses ?? 0
  for (;;) {
    try {
      if (owner) {
        const attached = await args.attach(owner)
        if (attached !== null) {
          return attached
        }
      }
      return await args.fresh()
    } catch (error) {
      if (!(error instanceof PaneOwnerContentionError) || losses++ >= 1) {
        throw error
      }
      owner = args.resolveOwner()
      if (!owner) {
        throw error
      }
    }
  }
}
