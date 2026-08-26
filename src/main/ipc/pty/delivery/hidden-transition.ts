import {
  markHiddenRendererPty,
  shouldDropHiddenRendererPtyData,
  unmarkHiddenRendererPty
} from '../../pty-hidden-delivery-gate'
import { invalidatePendingPtyDrainPolicy } from './visibility-state'
import type { PtyIpcSession } from '../session'

export function transitionHiddenRendererPtyDeliveryState(
  session: PtyIpcSession,
  id: string,
  hidden: boolean
): { droppable: boolean; droppedWhileHidden: boolean; policyChanged: boolean } {
  const settings = session.getSettings?.()
  const wasDroppable = shouldDropHiddenRendererPtyData(id, settings)
  let droppedWhileHidden = false
  if (hidden) {
    markHiddenRendererPty(id)
  } else {
    droppedWhileHidden = unmarkHiddenRendererPty(id).droppedWhileHidden
  }
  const droppable = shouldDropHiddenRendererPtyData(id, settings)
  return { droppable, droppedWhileHidden, policyChanged: wasDroppable !== droppable }
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
