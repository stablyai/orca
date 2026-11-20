import { closeStartupQueryAuthorityForPty } from '../provider/registry'
import { redactPtyIdForDiagnostics } from '../../../../shared/terminal/pty/diagnostics/pty-delivery-diagnostics'
import { mainDeliveryBreadcrumbs } from './debug'
import { toDroppedOutputSentinel } from './pending'
import {
  isHiddenRendererPty,
  isRendererRetainingGraphics,
  markHiddenRendererPty,
  recordHiddenPendingPtyDataDrop,
  shouldDropHiddenRendererPtyData,
  setRendererHiddenClaim,
  takeVisibleReportUnhideEpisode,
  unmarkHiddenRendererPty
} from './pty-hidden-delivery-gate'
import { invalidatePendingPtyDrainPolicy } from './visibility-state'
import { sendModelRestoreNeededMarker, sendPtyHiddenOutputActivity } from './payload'
import type { PtyIpcSession } from '../session'

export function transitionHiddenRendererPtyDeliveryState(
  session: PtyIpcSession,
  id: string,
  hidden: boolean
): {
  droppable: boolean
  droppedWhileHidden: boolean
  hiddenDropEpisode?: number
  policyChanged: boolean
} {
  const settings = session.getSettings?.()
  const wasDroppable = shouldDropHiddenRendererPtyData(id, settings)
  let unmarked: ReturnType<typeof unmarkHiddenRendererPty> = { droppedWhileHidden: false }
  if (hidden) {
    markHiddenRendererPty(id)
  } else {
    unmarked = unmarkHiddenRendererPty(id)
  }
  const droppable = shouldDropHiddenRendererPtyData(id, settings)
  return { droppable, ...unmarked, policyChanged: wasDroppable !== droppable }
}

export function transitionSpawnHiddenRendererPtyDeliveryState(
  session: PtyIpcSession,
  id: string,
  hidden: boolean
): void {
  const transition = transitionHiddenRendererPtyDeliveryState(session, id, hidden)
  if (transition.policyChanged) {
    invalidatePendingPtyDrainPolicy(id)
  }
}

/** Returns the drop episode whose 'unhide' marker was sent; `sentEpisode` was already sent by another reveal. */
export function revealHiddenRendererPty(
  session: PtyIpcSession,
  id: string,
  caller: string,
  sentEpisode?: number
): number | undefined {
  const transition = session.transitionHiddenRendererPtyDeliveryState(id, false)
  if (transition.policyChanged) {
    invalidatePendingPtyDrainPolicy(id)
  }
  session.syncPtyBackgroundedDelivery(id, caller)
  // Reload/remount can replace the marker consumer; repeat on reveal rather than lose recovery.
  if (!transition.droppedWhileHidden || transition.hiddenDropEpisode === sentEpisode) {
    return undefined
  }
  const sent = sendModelRestoreNeededMarker(
    session,
    id,
    'unhide',
    session.runtime?.getPtyOutputSequence(id),
    transition.hiddenDropEpisode
  )
  return sent ? transition.hiddenDropEpisode : undefined
}

/** Records a dropped hidden pending entry and tells the renderer the pane printed. */
export function dropHiddenPendingPtyData(
  session: PtyIpcSession,
  id: string,
  pending: { data: string; droppedOutput?: true }
): ReturnType<typeof recordHiddenPendingPtyDataDrop> {
  const drop = recordHiddenPendingPtyDataDrop(id, pending)
  if (drop.shouldEmitActivityNotice) {
    sendPtyHiddenOutputActivity(session, id)
  }
  return drop
}

export type HiddenRendererPtyClaim = { id: string; hidden: boolean; retainGraphics?: boolean }

export function updateHiddenRendererPtyClaim(
  session: PtyIpcSession,
  args: HiddenRendererPtyClaim
): void {
  if (typeof args.id !== 'string' || !args.id) {
    return
  }
  mainDeliveryBreadcrumbs.record(args.hidden === true ? 'gate-mark' : 'gate-unmark', {
    id: redactPtyIdForDiagnostics(args.id)
  })
  const wasRetainingGraphics = isRendererRetainingGraphics(args.id)
  const wasDroppable = shouldDropHiddenRendererPtyData(args.id, session.getSettings?.())
  setRendererHiddenClaim(args.id, args.hidden === true, args.retainGraphics === true)
  if (args.hidden !== true) {
    revealHiddenRendererPty(
      session,
      args.id,
      'gate-unmark',
      takeVisibleReportUnhideEpisode(args.id)
    )
    return
  }
  if (!isHiddenRendererPty(args.id)) {
    takeVisibleReportUnhideEpisode(args.id)
  }
  const transition = session.transitionHiddenRendererPtyDeliveryState(args.id, true)
  closeStartupQueryAuthorityForPty(args.id)
  // Newly hidden queued bytes can drop despite ACK starvation; reveal restores their model snapshot.
  const pending = session.pendingData.get(args.id)
  if (pending && transition.droppable) {
    session.pendingData.delete(args.id)
    // Queries queued while retaining were assigned to the renderer at ingestion.
    if (wasRetainingGraphics) {
      const sentinel = pending.droppedOutput === true ? pending : toDroppedOutputSentinel(pending)
      if (sentinel.data) {
        session.setPendingPtyData(args.id, sentinel)
        session.schedulePendingDataFlush(0)
      }
    }
    session.updateProducerFlowControl(args.id)
    session.pendingOverflowMarkedPtys.delete(args.id)
    const drop = dropHiddenPendingPtyData(session, args.id, pending)
    if (drop.shouldEmitRestoreMarker) {
      sendModelRestoreNeededMarker(
        session,
        args.id,
        'hidden-drop',
        session.runtime?.getPtyOutputSequence(args.id),
        drop.hiddenDropEpisode
      )
    }
  }
  if (wasDroppable !== transition.droppable) {
    invalidatePendingPtyDrainPolicy(args.id)
  }
  session.syncPtyBackgroundedDelivery(args.id, 'gate-mark')
}
