import type { OrcaRuntimeService } from '../../../../orca-runtime'
import {
  sessionCallerOf,
  type OrchestrationEntryCaller
} from '../../../../orchestration/addressing/orchestration-caller-identity'
import { requestAskersOf } from '../../../../../bots/bot-request-askers-of'
import type { BotRequestAsker } from '../../../../../../shared/bots/bot-acts-for'
import { parseBotAddress } from '../../../../../../shared/bot-roster'
import { orchestrationCallerIdentity } from '../runs/run-scope'
import { readActingSender } from './bot-recipient'
import { mayNameSession } from './session-recipient'

/** Whom the sending turn acts for, as a local send records it, for mail another computer may hand
 *  to one of its bots, so it never reads the request as the owner's alone. A session address may be
 *  a bot's chat there, which only that computer can tell; other mail carries none. */
export async function peerMailSendingAskers(
  runtime: OrcaRuntimeService,
  orchestrationCaller: OrchestrationEntryCaller | undefined,
  caller: { address: string; paneKey: string | null },
  mail: { to: string; chat?: string; item?: string }
): Promise<BotRequestAsker[] | undefined> {
  const mayReachBot =
    parseBotAddress(mail.to) !== null ||
    mayNameSession(mail.to) ||
    mail.chat !== undefined ||
    mail.item !== undefined
  if (!mayReachBot) {
    return undefined
  }
  const acting = await readActingSender(
    runtime,
    runtime.getOrchestrationDb(),
    sessionCallerOf(orchestrationCaller)?.sessionId,
    {
      sender: orchestrationCallerIdentity(runtime, {
        handle: caller.address,
        paneKey: caller.paneKey,
        session: orchestrationCaller
      })
    },
    null
  )
  return acting ? requestAskersOf(acting.turn) : undefined
}
