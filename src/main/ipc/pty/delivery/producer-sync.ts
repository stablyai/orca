import { recordDaemonStreamBacklogEvent } from '../../../daemon/daemon-stream-backlog-probe'
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
  if (session.sourceCreditPendingPtys.has(id)) {
    if (session.pendingData.get(id)) {
      return
    }
    session.sourceCreditPendingPtys.delete(id)
  }
  session.producerFlowControl.update(id, session.pendingData.get(id)?.data.length ?? 0)
}

export function syncPtyBackgroundedDelivery(
  session: PtyIpcSession,
  id: string,
  caller: string
): void {
  const background =
    session.rendererPtyIsKnownHidden(id) &&
    !(session.runtime?.hasRawTerminalViewSubscriber?.(id) ?? false)
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
    // Why: a recorded state the provider never took would short-circuit every later sync for this PTY.
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
