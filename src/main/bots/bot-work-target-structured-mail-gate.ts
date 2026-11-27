import {
  formatOrcaSessionAddress,
  isOrcaSessionId
} from '../../shared/agent-session/identity/orca-session-address'
import { ORCHESTRATION_UNBOUND_RUN_ID } from '../../shared/orchestration/orchestration-rpc-contract'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { OrchestrationDb } from '../runtime/orchestration/db/orchestration-db'
import type { MessageRow } from '../runtime/orchestration/db/orchestration-records'
import { readMessageWorkTargetProvenance } from '../runtime/orchestration/db/messages/message-work-target-provenance'
import type { StructuredPointerTarget } from '../runtime/orchestration/mailbox/structured-pointer/structured-mailbox-pointer-delivery'
import type { StructuredMailMessageVerifier } from '../runtime/orchestration/mailbox/structured-pointer/structured-mailbox-pointer-host-contract'
import {
  notifyTargetedMailHeld,
  preserveUnreadFollowUpMail
} from '../runtime/orchestration/workers/reports/work-target-mail-hold-notice'
import type { BotWorkTargetWorkspaceRuntime } from './bot-work-target-workspace-match'
import {
  partitionUnreadMessagesForBareRecipient,
  partitionUnreadMessagesForWorkerDispatch
} from './bot-work-target-unread-partition'

/** Gate whole-mail chat push delivery so drifted targeted mail stays unread and never injects into a chat turn. */
export function createStructuredMailWorkTargetVerifier(
  runtime: BotWorkTargetWorkspaceRuntime &
    Pick<
      OrcaRuntimeService,
      'showTerminal' | 'getOrchestrationDispatchAuthority' | 'notifyMessageArrived'
    >
): StructuredMailMessageVerifier {
  return async (
    db: OrchestrationDb,
    mailboxHandle: string,
    target: StructuredPointerTarget,
    message: MessageRow
  ) => {
    const provenance = readMessageWorkTargetProvenance(db, message.id)
    if (provenance.kind === 'absent') {
      return { ok: true, reverifySync: () => true }
    }
    const hold = (held: readonly { messageId: string; reason: string }[]) => {
      if (target.dispatchId) {
        preserveUnreadFollowUpMail(db, target.dispatchId)
      }
      const runIdFallback =
        message.run_id && message.run_id !== ORCHESTRATION_UNBOUND_RUN_ID
          ? message.run_id
          : undefined
      notifyTargetedMailHeld((handle, type) => runtime.notifyMessageArrived(handle, type), db, {
        ...(target.dispatchId ? { dispatchId: target.dispatchId } : { mailboxHandle }),
        heldMessageIds: held.map((item) => item.messageId),
        reason: held[0]!.reason,
        runIdFallback
      })
    }
    let partition
    if (target.dispatchId) {
      partition = await partitionUnreadMessagesForWorkerDispatch(runtime, db, target.dispatchId, [
        { id: message.id }
      ])
    } else {
      if (!isOrcaSessionId(target.sessionId)) {
        hold([
          {
            messageId: message.id,
            reason: `Chat session ${target.sessionId} has no verifiable work-target identity.`
          }
        ])
        return { ok: false }
      }
      partition = await partitionUnreadMessagesForBareRecipient(
        runtime,
        db,
        formatOrcaSessionAddress(target.sessionId),
        [{ id: message.id }]
      )
    }
    const initial = partition.reverifySync()
    if (initial.held.length > 0) {
      hold(initial.held)
      return { ok: false }
    }
    return {
      ok: true,
      reverifySync: () => {
        const checked = partition.reverifySync()
        if (checked.held.length > 0) {
          hold(checked.held)
          return false
        }
        return true
      }
    }
  }
}
