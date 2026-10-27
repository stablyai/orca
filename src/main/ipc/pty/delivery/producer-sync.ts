import { recordDaemonStreamBacklogEvent } from '../../../daemon/daemon-stream-backlog-probe'
import { isRuntimeOwnedHiddenRendererPty } from './pty-hidden-delivery-gate'
import { tryGetProviderForPty } from '../provider/registry'
import {
  PRODUCER_FLOW_CONTROL_ENABLED,
  rendererVisibilityKnownPtys,
  visibleRendererPtys
} from './visibility-state'
import type { PtyIpcSession } from '../session'

export function updateProducerFlowControl(session: PtyIpcSession, id: string): void {
  if (!PRODUCER_FLOW_CONTROL_ENABLED) {
    return
  }
  session.producerFlowControl.update(id, session.pendingData.get(id)?.data.length ?? 0)
}

export function syncPtyBackgroundedDelivery(
  session: PtyIpcSession,
  id: string,
  caller: string
): void {
  // Runtime spawns have no visibility reporter; pace them as hidden unless a renderer reports visible.
  const knownHidden =
    session.rendererPtyIsKnownHidden(id) ||
    (isRuntimeOwnedHiddenRendererPty(id) && !visibleRendererPtys.has(id))
  const background = knownHidden && !(session.runtime?.hasRawTerminalViewSubscriber?.(id) ?? false)
  if (session.backgroundedDeliverySyncByPty.get(id) === background) {
    return
  }
  const provider = tryGetProviderForPty(id)
  if (!provider?.setPtyBackgrounded) {
    return
  }
  recordDaemonStreamBacklogEvent('mainBackgroundSync', {
    sessionIdSuffix: id.slice(-10),
    background,
    caller,
    known: rendererVisibilityKnownPtys.has(id),
    visible: visibleRendererPtys.has(id)
  })
  const previous = session.backgroundedDeliverySyncByPty.get(id)
  session.backgroundedDeliverySyncByPty.set(id, background)
  try {
    provider.setPtyBackgrounded(id, background)
  } catch (error) {
    // Roll back failed provider changes so later syncs retry instead of trusting an unapplied state.
    if (previous === undefined) {
      session.backgroundedDeliverySyncByPty.delete(id)
    } else {
      session.backgroundedDeliverySyncByPty.set(id, previous)
    }
    console.error('[pty] setPtyBackgrounded failed; delivery sync state rolled back', error)
  }
}

export function resyncBackgroundedDeliveriesAfterGateReset(session: PtyIpcSession): void {
  for (const id of session.backgroundedDeliverySyncByPty.keys()) {
    syncPtyBackgroundedDelivery(session, id, 'gate-reset')
  }
}
