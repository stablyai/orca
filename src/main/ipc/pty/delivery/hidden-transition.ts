import {
  markHiddenRendererPty,
  shouldDropHiddenRendererPtyData,
  unmarkHiddenRendererPty
} from './pty-hidden-delivery-gate'
import { invalidatePendingPtyDrainPolicy } from './visibility-state'
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
