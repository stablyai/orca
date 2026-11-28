import type { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { isPotentiallyLiveRemoteAttachment } from '../../../../orchestration/db/federation/remote-attachment-liveness'
import type { BareRecipientResolution } from './recipient-routing'
import type { SessionRecipientRefusal } from './session-recipient'
import { withDispatchPrefixHint } from './dispatch-prefix-hint'

export type LegacyAttachmentRefusal = {
  code: 'capability_unsupported' | 'dispatch_inactive'
  message: string
}

const LEGACY_ATTACHMENT_REFUSAL_CODES: readonly string[] = [
  'capability_unsupported',
  'dispatch_inactive'
] satisfies LegacyAttachmentRefusal['code'][]

/** A terminal working another Orca's Task reads only that Task's mail, which only its home writes. */
export function legacyAttachmentRefusal(
  db: OrchestrationDb,
  terminalHandle: string,
  livePaneKey: string | null | undefined
): LegacyAttachmentRefusal | undefined {
  const attachment =
    (livePaneKey ? db.findActiveRemoteAttachmentForPane(livePaneKey) : undefined) ??
    retainedLiveAttachment(db, terminalHandle)
  if (!attachment) {
    return undefined
  }
  return attachment.state === 'ready'
    ? {
        code: 'capability_unsupported',
        message: `${terminalHandle} is working a Task for another Orca; mail can't reach it there. Message that Task's coordinator.`
      }
    : {
        code: 'dispatch_inactive',
        message: `${terminalHandle} is starting or finishing a Task for another Orca.`
      }
}

// The handle the attachment recorded, for a pane the live lookup no longer resolves.
function retainedLiveAttachment(db: OrchestrationDb, terminalHandle: string) {
  const retained = db.findLatestRemoteAttachmentForTerminal(terminalHandle)
  return isPotentiallyLiveRemoteAttachment(retained) ? retained : undefined
}

/** The resolver step: a bare terminal another Orca's Task holds, by live pane or recorded handle. */
export function legacyAttachedRecipient(
  db: OrchestrationDb,
  recipient: string,
  terminalHandle: string | null,
  livePaneKey: string | undefined
): BareRecipientResolution | undefined {
  const refusal =
    terminalHandle === null ? undefined : legacyAttachmentRefusal(db, terminalHandle, livePaneKey)
  return refusal && refusedRecipient(recipient, refusal)
}

export function refusedRecipient(
  recipient: string,
  refusal: SessionRecipientRefusal | LegacyAttachmentRefusal
): BareRecipientResolution {
  return {
    ok: false,
    code: refusal.code,
    message: refusal.message,
    warning: { code: 'recipient_unreachable', recipient, message: refusal.message }
  }
}

/** A refused send recipient; a legacy attachment's refusal says nothing was sent. */
export function sendRecipientRefusal(
  db: OrchestrationDb,
  to: string,
  refusal: { code: string; message: string }
): OrchestrationError {
  return isLegacyAttachmentRefusal(refusal)
    ? legacyAttachmentError(refusal, 'Nothing was sent.')
    : new OrchestrationError(refusal.code, withDispatchPrefixHint(db, to, refusal))
}

export function isLegacyAttachmentRefusal(refusal: { code: string }): boolean {
  return LEGACY_ATTACHMENT_REFUSAL_CODES.includes(refusal.code)
}

export function legacyAttachmentError(
  refusal: { code: string; message: string },
  nothingDone: string
): OrchestrationError {
  return new OrchestrationError(refusal.code, `${refusal.message} ${nothingDone}`, {
    effectsApplied: false
  })
}

/** Store-time recheck for a bare terminal recipient resolved before an await. */
export function refuseLegacyAttachedRecipient(
  runtime: OrcaRuntimeService,
  db: OrchestrationDb,
  to: string,
  nothingDone: string
): void {
  if (to.startsWith('run:') || to.startsWith('dispatch:')) {
    return
  }
  const refusal = legacyAttachmentRefusal(db, to, runtime.getLiveTerminalPaneKey(to))
  if (refusal) {
    throw legacyAttachmentError(refusal, nothingDone)
  }
}
