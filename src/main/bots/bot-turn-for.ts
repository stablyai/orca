// Whom a bot's running turn acts for, as its Slack actions tell Orca Cloud (item 167): another Orca bot
// hears a post as that person, and a read by the owner's turn reads as the owner. Only the owner's own
// turn says owner. A request Orca didn't verify as the chat itself (another session, or none it could
// verify) says none, so its post counts as no one, not even the person its turn started for.
import type { ConnectorTurnFor } from '../../shared/connectors/connector-cloud-contract'
import { isOrcaSessionId } from '../../shared/agent-session/identity/orca-session-address'
import { canonicalOrcaSessionId } from '../runtime/orchestration/addressing/session-lineage/canonical-orca-session-id'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { readBotTurn } from '../runtime/rpc/methods/orchestration/messaging/bot-recipient'
import { turnActsForOwner, type BotActingTurn } from './bot-request-asker'

/** Whether two ids name one agent session, however each is spelled. */
export const sameSession = (a: string, b: string): boolean =>
  (isOrcaSessionId(a) ? canonicalOrcaSessionId(a) : a) ===
  (isOrcaSessionId(b) ? canonicalOrcaSessionId(b) : b)

/** Who asks: the host itself (a run's final result it delivers), or a request with the session Orca
 *  verified it came from; `undefined` when it verified none (a paired client, or no evidence). */
export type BotTurnCaller = 'host' | { verifiedSessionId: string | undefined }

/** `known`: the running turn, when the caller already read it. */
export async function botTurnFor(
  runtime: OrcaRuntimeService,
  sessionId: string,
  caller: BotTurnCaller,
  known?: BotActingTurn
): Promise<ConnectorTurnFor> {
  if (
    caller !== 'host' &&
    (caller.verifiedSessionId === undefined || !sameSession(caller.verifiedSessionId, sessionId))
  ) {
    return 'none'
  }
  try {
    const turn = known ?? (await readBotTurn(runtime, runtime.getOrchestrationDb(), sessionId)).turn
    return turnActsForOwner(turn) ? 'owner' : 'someone_else'
  } catch (error) {
    console.warn('[bots] could not read whom a turn acts for', error)
    return 'someone_else'
  }
}
