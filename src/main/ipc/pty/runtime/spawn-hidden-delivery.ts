import { markRuntimeOwnedHiddenRendererPty } from '../../pty-hidden-delivery-gate'
import { visibleRendererPtys } from '../delivery/visibility-state'
import { closeStartupQueryAuthorityForPty } from '../provider/registry'
import type { RuntimePtySpawnState } from './spawn-state'

// Why: a background runtime spawn has no renderer view until the user opens its tab, so nothing
// answers CPR/DA1 unless main owns the PTY as hidden (terminal-query-authority: main answers iff
// the hidden gate drops the chunk). Muse exits silently when its startup CPR goes unanswered.

/** Daemon PTYs can emit before spawn() resolves, so the mark must precede byte zero. */
export function markRuntimeSpawnHiddenBeforeSpawn(ctx: RuntimePtySpawnState): void {
  // Why only fresh sessions: a reattached session id may already back a visible pane.
  if (
    ctx.args.initiallyHidden !== true ||
    !ctx.isNewDaemonSession ||
    ctx.effectiveSessionAppId === undefined
  ) {
    return
  }
  ctx.preSpawnHiddenMarkId = ctx.effectiveSessionAppId
  markRuntimeSpawnHidden(ctx, ctx.preSpawnHiddenMarkId)
}

/** Runs after commit: ptyOwnership must exist so backgrounded pacing can route to the provider. */
export function commitRuntimeSpawnHiddenDelivery(ctx: RuntimePtySpawnState): void {
  if (ctx.args.initiallyHidden !== true) {
    return
  }
  const { id } = ctx.result
  if (
    ctx.result.isReattach === true ||
    ctx.stablePaneOwner ||
    isAdoptedAgentSession(ctx.result.agentSessionEnsure)
  ) {
    releaseRuntimeSpawnPreSpawnHiddenMark(ctx)
    return
  }
  // Why: a view that mounted visible during spawn already unmarked; re-marking would drop its output.
  if (visibleRendererPtys.has(id)) {
    releaseRuntimeSpawnPreSpawnHiddenMark(ctx)
    ctx.deps.syncPtyBackgroundedDelivery?.(id, 'spawn')
    return
  }
  markRuntimeSpawnHidden(ctx, id)
  if (ctx.preSpawnHiddenMarkId !== id) {
    releaseRuntimeSpawnPreSpawnHiddenMark(ctx)
  }
  ctx.deps.syncPtyBackgroundedDelivery?.(id, 'spawn')
  closeStartupQueryAuthorityForPty(id)
}

/** A stale mark on a session id would gate a later visible attach that reuses it. */
export function releaseRuntimeSpawnPreSpawnHiddenMark(ctx: RuntimePtySpawnState): void {
  if (ctx.preSpawnHiddenMarkId === null) {
    return
  }
  ctx.deps.transitionSpawnHiddenRendererPtyDeliveryState?.(ctx.preSpawnHiddenMarkId, false)
  ctx.preSpawnHiddenMarkId = null
}

function markRuntimeSpawnHidden(ctx: RuntimePtySpawnState, id: string): void {
  const transition = ctx.deps.transitionSpawnHiddenRendererPtyDeliveryState
  if (!transition) {
    return
  }
  // Transition first so a fresh mark still invalidates the drain policy.
  transition(id, true)
  // Why runtime-owned: no renderer party re-marks this PTY after a reload/crash gate reset.
  markRuntimeOwnedHiddenRendererPty(id)
}

function isAdoptedAgentSession(ensure: unknown): boolean {
  return (
    typeof ensure === 'object' &&
    ensure !== null &&
    'disposition' in ensure &&
    ensure.disposition === 'adopted'
  )
}
