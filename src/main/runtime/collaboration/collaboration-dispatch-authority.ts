import { OrchestrationError } from '../orchestration/orchestration-error'
import type { DispatchContextRow } from '../orchestration/types'
import type { OrcaRuntimeService } from '../orca-runtime'

// Why: local-only collaboration authority resolves the active Dispatch from
// the sender's terminal identity — never from caller-supplied task/dispatch ids.
export function requireLocalCollaborationDispatchAuthority(
  runtime: OrcaRuntimeService,
  from: string,
  orchestrationCapability?: string
): DispatchContextRow {
  const db = runtime.getOrchestrationDb()
  const paneKey = runtime.getTerminalPaneKey(from) ?? undefined
  const dispatch = db.getActiveDispatchForIdentity(from, paneKey)
  if (!dispatch) {
    throw new OrchestrationError('dispatch_inactive', `No active Dispatch for terminal ${from}.`)
  }
  if (dispatch.capability_hash) {
    const verification = db.verifyDispatchCapability({
      dispatchId: dispatch.id,
      capability: orchestrationCapability,
      paneKey,
      processIncarnation: runtime.getTerminalProcessIncarnation(from) ?? undefined
    })
    if (!verification.valid) {
      throw new OrchestrationError('dispatch_capability_invalid', verification.reason)
    }
  } else if (!db.isDispatchMessageSender({ dispatchId: dispatch.id, handle: from, paneKey })) {
    throw new OrchestrationError(
      'sender_not_assignee',
      `Terminal ${from} is not the assignee of Dispatch ${dispatch.id}.`
    )
  }
  return dispatch
}
