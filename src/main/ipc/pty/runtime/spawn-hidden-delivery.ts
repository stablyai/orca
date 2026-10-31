import { markRuntimeOwnedHiddenRendererPty } from '../delivery/pty-hidden-delivery-gate'
import { attachingRendererViewPtys, isRendererViewShowingPty } from '../delivery/visibility-state'
import { closeStartupQueryAuthorityForPty } from '../provider/registry'
import type { RuntimePtySpawnState } from './spawn-state'
import type { PtyRuntimeControllerDeps } from './controller-deps'

// Background launches have no renderer to answer startup queries; main must own hidden-query replies.

export function markRuntimeSpawnHiddenBeforeSpawn(ctx: RuntimePtySpawnState): void {
  // Reattached IDs may already back visible panes.
  if (
    ctx.args.initiallyHidden !== true ||
    !ctx.ownsNewIncarnation ||
    ctx.effectiveSessionAppId === undefined
  ) {
    return
  }
  const attaching = attachingRendererViewPtys.get(ctx.effectiveSessionAppId)
  if (attaching) {
    attaching.skippedHide = true
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
  // A visible view arriving during spawn already owns delivery; re-hiding would drop output and force another restore.
  const attaching = attachingRendererViewPtys.get(id)
  if (attaching) {
    attaching.skippedHide = true
  }
  if (isRendererViewShowingPty(id)) {
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
  hideRuntimeOwnedRendererDelivery(ctx.deps, id)
}

/** Main-held streams with no view drop renderer bytes until a pane reveals them. */
export function hideRuntimeOwnedRendererDelivery(
  deps: Pick<PtyRuntimeControllerDeps, 'transitionSpawnHiddenRendererPtyDeliveryState'>,
  id: string
): void {
  const transition = deps.transitionSpawnHiddenRendererPtyDeliveryState
  if (!transition) {
    return
  }
  // Transition first so a fresh mark still invalidates the drain policy.
  transition(id, true)
  // No renderer exists to re-mark this PTY after reload.
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
