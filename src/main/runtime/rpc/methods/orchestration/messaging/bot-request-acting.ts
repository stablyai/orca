// Who a send to a bot acts for. Mail from an agent on a paired server acts for no one this computer
// can name: that server has no access here, so its mail never acts for the owner, nor as a chat or
// worker here, whatever sender label it carries.
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import type { OrchestrationPartyIdentity as OrchestrationCallerIdentity } from '../../../../../../shared/orchestration/mailbox/orchestration-party-identity'
import { readActingSender, type ActingSender, type ReceivingBot } from './bot-recipient'

export const PAIRED_SERVER_SENDER: ActingSender = {
  sessionId: null,
  bot: null,
  turn: {
    rootItemId: null,
    askers: [{ kind: 'unknown' }],
    askedBy: [{ kind: 'unknown' }],
    request: null,
    actingOnRequestId: null,
    requestIds: [],
    wokenAt: null
  },
  conversation: null
}

export function readSendingActor(
  runtime: OrcaRuntimeService,
  db: OrchestrationDb,
  mail: {
    callerSessionId: string | undefined
    sender: OrchestrationCallerIdentity
    receiving: ReceivingBot
    /** Pulled from a server this computer dials: only that path sets it. */
    pulledFromServer?: boolean
  }
): Promise<ActingSender | null> {
  return mail.pulledFromServer === true
    ? Promise.resolve(PAIRED_SERVER_SENDER)
    : readActingSender(runtime, db, mail.callerSessionId, mail.sender, mail.receiving)
}
