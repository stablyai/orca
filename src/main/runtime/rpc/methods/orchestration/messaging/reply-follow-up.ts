import type { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import type { MessageRow } from '../../../../orchestration/db/orchestration-records'
import type { WorkerLineage } from '../../../../orchestration/db/dispatch-context/worker-follow-up-lineage'
import { completionReportFollowUp } from '../../../../orchestration/workers/reports/report-follow-up-action'
import { resolveOrcaSessionParty } from '../../../../orchestration/addressing/orchestration-party'
import type { OrchestrationPartyIdentity as OrchestrationCallerIdentity } from '../../../../../../shared/orchestration/mailbox/orchestration-party-identity'
import {
  isOrcaSessionId,
  parseOrcaSessionAddress
} from '../../../../../../shared/agent-session/identity/orca-session-address'
import {
  formatNotYoursReplyRefusal,
  type ReportFollowUpAction
} from '../../../../../../shared/orchestration/mailbox/orchestration-report-follow-up'
import type { OrchestrationSessionCaller } from '../../../../orchestration/addressing/orchestration-caller-identity'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { botOfSession } from '../../../../../bots/bot-session-tabs'
import { orchestrationCallerIdentity } from '../runs/run-scope'
import { resolveReplyRecipient } from './recipient-routing'
import type { TerminalAgentRecipient } from './session-recipient'
import { creatorSession } from './bot-recipient'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { StructuredMailFollowUp } from '../../../../orchestration/mailbox/structured-pointer/structured-mailbox-pointer-host-contract'

/** What a view prints in place of `[Reply:]` for this reader, in reply's own order: a finished task's
 *  report offers its follow-up, mail reply would refuse the reader names the send that works, and
 *  status a bot got from another says there is nothing to answer. */
export function replyFollowUp(
  runtime: OrcaRuntimeService,
  db: OrchestrationDb,
  message: MessageRow,
  reader: { party: OrchestrationCallerIdentity; sessionId: string } | undefined,
  lineageCache?: Map<string, WorkerLineage>
): ReportFollowUpAction | undefined {
  const report = completionReportFollowUp(db, message, lineageCache)
  if (report || db.getQuestion(message.id)) {
    return report
  }
  const refused = refusedReplyFollowUp(runtime, db, message, hintReplier(runtime, message, reader))
  if (refused) {
    return refused
  }
  return db.getBotRequest(message.id)?.purpose === 'status' ? { kind: 'information' } : undefined
}

/** A chat's reply follow-up, as structured mail shows it to the chat that reads it. */
export function chatReplyFollowUp(runtime: OrcaRuntimeService): StructuredMailFollowUp {
  return (db, message, sessionId) => replyFollowUp(runtime, db, message, chatReader(db, sessionId))
}

/** The reader a chat is, for `replyFollowUp`; undefined when Orca can no longer name its party. */
export function chatReader(
  db: OrchestrationDb,
  sessionId: string
): { party: OrchestrationCallerIdentity; sessionId: string } | undefined {
  if (!isOrcaSessionId(sessionId)) {
    return undefined
  }
  try {
    return { party: resolveOrcaSessionParty(sessionId, db), sessionId }
  } catch {
    return undefined
  }
}

/** The mail `reply` sends instead when it refuses this replier: null when it accepts. A reply that lands
 *  in a bot's chat comes from the bot a request went to, the party the mail went to, or the bot's own
 *  worker. Every `[Reply:]` hint asks this too. */
export function refusedReplyFollowUp(
  runtime: OrcaRuntimeService,
  db: OrchestrationDb,
  original: MessageRow,
  replier: { identity: OrchestrationCallerIdentity; sessionId: string | null }
): ReportFollowUpAction | null {
  const request = db.getBotRequest(original.id)
  const senderSession = parseOrcaSessionAddress(original.from_handle)
  const senderBot = senderSession ? botOfSession(runtime.bots, senderSession) : null
  if (request) {
    const replierBot = replier.sessionId ? botOfSession(runtime.bots, replier.sessionId) : null
    if (replierBot?.id === request.to_bot_id) {
      return null
    }
  } else if (senderBot) {
    const creator = creatorSession(db, replier.identity).sessionId
    const ownWorker = creator !== null && botOfSession(runtime.bots, creator)?.id === senderBot.id
    if (ownWorker || replier.identity.address === original.to_handle) {
      return null
    }
  } else {
    return null
  }
  return senderBot && senderSession
    ? { kind: 'mail_sender', to: `bot:${senderBot.name}`, chat: senderSession }
    : { kind: 'mail_sender', to: original.from_handle }
}

/** Who runs a printed `[Reply:]` hint: the mail's reader (a chat's own party), declaring the mail's address. */
export function hintReplier(
  runtime: OrcaRuntimeService,
  message: MessageRow,
  reader: { party: OrchestrationCallerIdentity; sessionId: string } | undefined
): { identity: OrchestrationCallerIdentity; sessionId: string | null } {
  return reader
    ? { identity: reader.party, sessionId: reader.sessionId }
    : {
        identity: orchestrationCallerIdentity(runtime, {
          handle: message.to_handle,
          session: undefined,
          paneKey: runtime.getTerminalPaneKey(message.to_handle)
        }),
        sessionId: null
      }
}

/** Where a reply goes, once Orca knows `refusedReplyFollowUp` accepts the replier. */
export function resolveCheckedReplyRecipient(
  runtime: OrcaRuntimeService,
  db: OrchestrationDb,
  original: MessageRow,
  replying: {
    from: string | undefined
    caller: OrchestrationSessionCaller | undefined
    terminalRecipient: TerminalAgentRecipient
  }
): ReturnType<typeof resolveReplyRecipient> {
  const identity = orchestrationCallerIdentity(runtime, {
    handle: replying.from ?? original.to_handle,
    session: replying.caller,
    paneKey: replying.from ? runtime.getTerminalPaneKey(replying.from) : null
  })
  const followUp = refusedReplyFollowUp(runtime, db, original, {
    identity,
    sessionId: replying.caller?.sessionId ?? null
  })
  if (followUp) {
    throw new OrchestrationError('bot_reply_not_yours', formatNotYoursReplyRefusal(followUp), {
      effectsApplied: false,
      followUp
    })
  }
  return resolveReplyRecipient({
    runtime,
    db,
    originalFrom: original.from_handle,
    originalRunId: original.run_id,
    terminalRecipient: replying.terminalRecipient
  })
}
