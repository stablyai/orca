import type { OrchestrationCompatibilityEvidence } from '../../../../../../shared/orchestration-compatibility-evidence'
import type { OrchestrationDb } from '../../../../orchestration/db'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import {
  assertScheduledWaitSender,
  type ScheduledWaitMessage
} from '../../../../orchestration/scheduled-wait-message'
import { clearWorkerScheduledWait } from '../../../../orchestration/db/worker-scheduled-waits'
import { assertLifecycleCallerIsNotAnotherParty } from './lifecycle-caller-fence'
import { isWorkerReportOutcome, parseRemoteWorkerPayload } from '../schemas'

export type MessageProgressCaller = {
  evidence?: OrchestrationCompatibilityEvidence
  authenticatedSession: boolean
}

export function assertSendLifecycleAdmission(args: {
  db: OrchestrationDb
  params: { to?: string; type?: string; payload?: string }
  dispatchId: string | undefined
  from: string
  senderPaneKey: string | undefined
  scheduledWait: ScheduledWaitMessage | undefined
  resolveProcessIncarnation: () => string | undefined
}): void {
  if (
    args.params.type === 'worker_done' &&
    !isWorkerReportOutcome(parseRemoteWorkerPayload(args.params.payload).outcome)
  ) {
    throw new OrchestrationError(
      'invalid_argument',
      'worker_done requires outcome=succeeded|failed for a current Dispatch.'
    )
  }
  if (args.scheduledWait) {
    assertScheduledWaitSender(args.db, args.params, args.dispatchId, {
      from: args.from,
      paneKey: args.senderPaneKey,
      processIncarnation: args.resolveProcessIncarnation()
    })
  }
}

export function isWorkerMessageProgressCaller(
  runtime: OrcaRuntimeService,
  args: {
    from: string
    senderPaneKey: string | undefined
    caller: MessageProgressCaller
  }
): boolean {
  try {
    if (!args.caller.authenticatedSession) {
      assertLifecycleCallerIsNotAnotherParty(runtime, {
        from: args.from,
        fromPaneKey: args.senderPaneKey,
        evidence: args.caller.evidence
      })
    }
    return true
  } catch {
    return false
  }
}

export function clearWorkerWaitOnMessageProgress(
  runtime: OrcaRuntimeService,
  db: OrchestrationDb,
  args: {
    from: string
    senderPaneKey: string | undefined
    caller: MessageProgressCaller
    resolveProcessIncarnation: () => string | undefined
  }
): void {
  const dispatch = db.getActiveDispatchForIdentity(args.from, args.senderPaneKey)
  if (
    !dispatch ||
    !db.db.prepare('SELECT 1 FROM worker_scheduled_waits WHERE dispatch_id = ?').get(dispatch.id) ||
    !db.isDispatchMessageSender({
      dispatchId: dispatch.id,
      handle: args.from,
      paneKey: args.senderPaneKey
    })
  ) {
    return
  }
  if (!isWorkerMessageProgressCaller(runtime, args)) {
    return
  }
  try {
    if (
      dispatch.process_incarnation &&
      !db.isDispatchProcessCurrent({
        dispatchId: dispatch.id,
        paneKey: args.senderPaneKey ?? null,
        processIncarnation: args.resolveProcessIncarnation() ?? null
      })
    ) {
      return
    }
  } catch {
    return
  }
  clearWorkerScheduledWait(db, dispatch.id)
}
