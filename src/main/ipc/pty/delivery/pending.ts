import { extractHiddenStartupRendererQueryData } from '../../../../shared/terminal-reply-query-extraction'
import {
  INITIAL_MODE_2031_REPLY_SCAN_STATE,
  scanMode2031ReplyDecision,
  type Mode2031ReplyScanState
} from '../../../../shared/terminal-color-scheme-protocol'
import {
  INITIAL_SYNCHRONIZED_OUTPUT_LATCH_STATE,
  advanceDroppedSynchronizedOutputLatch
} from '../../../../shared/terminal-synchronized-output-scan'
import { redactPtyIdForDiagnostics } from '../../../../shared/pty-delivery-diagnostics'
import { recordCrashBreadcrumb } from '../../../crash-reporting/crash-breadcrumb-store'
import { terminalOutputBacklogCapChars } from '../../../../shared/terminal-scrollback-policy'
import {
  isHiddenPtyDeliveryGateEnabled,
  type RendererPtyViewDelivery
} from '../../pty-hidden-delivery-gate'
import {
  appendPendingProjectionAdmission,
  compactPendingProjectionAdmissions,
  type PendingProjectionAdmissions
} from '../../pty-pending-projection-admissions'
import type { PendingPtyData } from '../../pty-pending-data-drain-queue'
import { DROPPED_QUERY_SALVAGE_MAX_CHARS } from './constants'
import type { PtyIpcSession } from '../session'

export function pendingDataCapChars(session: PtyIpcSession): number {
  return terminalOutputBacklogCapChars(session.getSettings?.().terminalScrollbackRows)
}

export function extractDroppedPtyQueryBytes(data: string): string {
  if (!data.includes('\x1b')) {
    return ''
  }
  const extracted = extractHiddenStartupRendererQueryData(data, '')
  return extracted.statelessQueryData + extracted.statefulQueryData + extracted.oscColorQueryData
}

export function scanDroppedMode2031Data(
  data: string,
  previous: Mode2031ReplyScanState
): { data: string; state: Mode2031ReplyScanState } {
  const result = scanMode2031ReplyDecision(previous, data)
  const decisionData =
    result.decision === 'subscribed'
      ? '\x1b[?2031h'
      : result.decision === 'unsubscribed'
        ? '\x1b[?2031l'
        : ''
  return { data: decisionData, state: result.state }
}

export function getDroppedMode2031RendererData(pending: PendingPtyData): string {
  const state = pending.droppedMode2031ScanState
  if (!state) {
    return pending.droppedMode2031Data ?? ''
  }
  const pendingSubscribe = state.pendingSubscribe ? '\x1b[?2031h' : ''
  return (pending.droppedMode2031Data ?? '') + pendingSubscribe + state.tail
}

/** Releases xterm's DEC 2026 render hold when the dropped span left a frame open.
 *  Without it the pane freezes on its last painted frame until xterm's 1000ms
 *  forced flush. */
export function getDroppedSynchronizedOutputRendererData(pending: PendingPtyData): string {
  return pending.droppedSynchronizedOutputState?.active === true ? '\x1b[?2026l' : ''
}

export function pendingProjectionAdmissionOptions(session: PtyIpcSession) {
  return {
    isPending: (id: string) => session.sshOutputIntake?.hasUnpublishedProjection(id) ?? false,
    transfer: (ids: readonly string[], reason: string) =>
      session.sshOutputIntake?.transferProjections(ids, reason)
  }
}

export function updatePendingProjectionAdmissions(
  pending: PendingPtyData,
  state: PendingProjectionAdmissions
): void {
  delete pending.projectionAdmissionIds
  delete pending.projectionAdmissionsTransferred
  if (state.projectionAdmissionIds) {
    pending.projectionAdmissionIds = state.projectionAdmissionIds
  }
  if (state.projectionAdmissionsTransferred) {
    pending.projectionAdmissionsTransferred = true
  }
}

export function compactPendingProjectionState(
  session: PtyIpcSession,
  pending: PendingProjectionAdmissions,
  projectionSemanticsId?: string
): PendingProjectionAdmissions {
  const options = pendingProjectionAdmissionOptions(session)
  const compacted = compactPendingProjectionAdmissions(pending, options)
  return projectionSemanticsId
    ? appendPendingProjectionAdmission(compacted, projectionSemanticsId, options)
    : compacted
}

export function dropOversizedPendingPtyData(
  session: PtyIpcSession,
  id: string,
  pending: PendingPtyData
): PendingPtyData {
  const capChars = pendingDataCapChars(session)
  if (pending.droppedOutput === true || pending.data.length <= capChars) {
    return pending
  }
  if (!session.pendingDataDropWarnedPtys.has(id)) {
    session.pendingDataDropWarnedPtys.add(id)
    console.error(
      `[pty] dropped ${pending.data.length} buffered chars for ${redactPtyIdForDiagnostics(id)}: renderer not receiving and per-PTY pending cap exceeded; pane will restore from the main-owned snapshot`
    )
    // Why: field visibility for cap tuning (issue #2836 / #7017); no pty id since session ids can embed workspace paths.
    recordCrashBreadcrumb('terminal_pending_output_dropped', {
      droppedChars: pending.data.length,
      capChars
    })
  }
  if (
    isHiddenPtyDeliveryGateEnabled(session.getSettings?.()) &&
    !session.pendingOverflowMarkedPtys.has(id)
  ) {
    session.pendingOverflowMarkedPtys.add(id)
  }
  session.pendingDroppedChars += pending.data.length
  if (pending.projectionAdmissionIds) {
    session.sshOutputIntake?.transferProjections(pending.projectionAdmissionIds, 'pending-cap')
  }
  const mode2031 = scanDroppedMode2031Data(pending.data, INITIAL_MODE_2031_REPLY_SCAN_STATE)
  const synchronizedOutput = advanceDroppedSynchronizedOutputLatch(
    pending.data,
    INITIAL_SYNCHRONIZED_OUTPUT_LATCH_STATE
  )
  // Why no trimmed content tail: a mid-stream gap would corrupt the pane; the droppedOutput sentinel repaints from the snapshot and realigns by sequence (only query bytes ride along).
  // Bytes the view did not own at ingestion had their queries answered outside it.
  return {
    data: pending.ingestedDelivery
      ? ''
      : extractDroppedPtyQueryBytes(pending.data).slice(0, DROPPED_QUERY_SALVAGE_MAX_CHARS),
    ...(pending.ingestedDelivery ? { ingestedDelivery: pending.ingestedDelivery } : {}),
    droppedOutput: true,
    droppedMode2031Data: mode2031.data,
    droppedMode2031ScanState: mode2031.state,
    droppedSynchronizedOutputState: synchronizedOutput.state
  }
}

export function appendPendingPtyData(
  session: PtyIpcSession,
  id: string,
  existing: PendingPtyData | undefined,
  data: string,
  startSeq: number | undefined,
  preservesSeq: boolean,
  containsBackgroundOutput: boolean,
  rawLength = data.length,
  transformed = false,
  projectionSemanticsId?: string,
  ingestedDelivery: RendererPtyViewDelivery = 'parse'
): PendingPtyData {
  // Why stay dropped at O(1): once over the cap the restore sentinel supersedes interim bytes; queries still get carved out (bounded) so replies survive the whole episode.
  if (existing?.droppedOutput === true) {
    if (projectionSemanticsId) {
      session.sshOutputIntake?.transferProjections([projectionSemanticsId], 'pending-cap')
    }
    const mode2031 = scanDroppedMode2031Data(
      data,
      existing.droppedMode2031ScanState ?? INITIAL_MODE_2031_REPLY_SCAN_STATE
    )
    const synchronizedOutput = advanceDroppedSynchronizedOutputLatch(
      data,
      existing.droppedSynchronizedOutputState ?? INITIAL_SYNCHRONIZED_OUTPUT_LATCH_STATE
    )
    const remainingQueryCapacity = Math.max(
      0,
      DROPPED_QUERY_SALVAGE_MAX_CHARS - existing.data.length
    )
    const salvaged = existing.ingestedDelivery
      ? ''
      : extractDroppedPtyQueryBytes(data).slice(0, remainingQueryCapacity)
    return {
      ...existing,
      data: existing.data + salvaged,
      droppedMode2031Data: mode2031.data || existing.droppedMode2031Data,
      droppedMode2031ScanState: mode2031.state,
      droppedSynchronizedOutputState: synchronizedOutput.state
    }
  }
  const projectionState = compactPendingProjectionState(
    session,
    existing ?? {},
    projectionSemanticsId
  )
  const nextContainsBackgroundOutput =
    existing?.containsBackgroundOutput === true || containsBackgroundOutput
  if (!existing) {
    const pending: PendingPtyData = {
      data,
      ...(typeof startSeq === 'number' ? { startSeq } : {}),
      ...(rawLength !== data.length ? { rawLength } : {}),
      ...(transformed ? { transformed: true } : {}),
      ...(nextContainsBackgroundOutput ? { containsBackgroundOutput: true } : {}),
      ...(ingestedDelivery !== 'parse' ? { ingestedDelivery } : {})
    }
    updatePendingProjectionAdmissions(pending, projectionState)
    return dropOversizedPendingPtyData(session, id, pending)
  }
  const existingRawLength = existing.rawLength ?? existing.data.length
  const next: PendingPtyData = {
    data: existing.data + data,
    ...(!preservesSeq || existing.transformed || transformed
      ? { rawLength: existingRawLength + rawLength, transformed: true as const }
      : {}),
    ...(nextContainsBackgroundOutput ? { containsBackgroundOutput: true } : {}),
    // Callers settle an owner change first (settlePendingDeliveryStamp), so both sides agree.
    ...(existing.ingestedDelivery ? { ingestedDelivery: existing.ingestedDelivery } : {})
  }
  updatePendingProjectionAdmissions(next, projectionState)
  if (typeof existing.startSeq === 'number') {
    next.startSeq = existing.startSeq
  }
  return dropOversizedPendingPtyData(session, id, next)
}
