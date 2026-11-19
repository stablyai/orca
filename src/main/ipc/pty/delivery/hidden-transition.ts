import {
  markHiddenRendererPty,
  recordHiddenPendingPtyDataDrop,
  shouldDropHiddenRendererPtyData,
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
