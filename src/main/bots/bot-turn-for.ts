// Whom a bot's running turn acts for, as its Slack posts tell Orca Cloud (item 167): another Orca bot
// hears a post as that person. Only the owner's own turn says owner. A session other than the
// verified caller says none, so its post counts as no one, not even the person its turn started for.
import { actsForOwner } from '../../shared/bots/bot-acts-for'
import type { ConnectorTurnFor } from '../../shared/connectors/connector-cloud-contract'
import { isOrcaSessionId } from '../../shared/agent-session/identity/orca-session-address'
import { canonicalOrcaSessionId } from '../runtime/orchestration/addressing/session-lineage/canonical-orca-session-id'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { readBotTurn } from '../runtime/rpc/methods/orchestration/messaging/bot-recipient'

/** Whether two ids name one agent session, however each is spelled. */
export const sameSession = (a: string, b: string): boolean =>
  (isOrcaSessionId(a) ? canonicalOrcaSessionId(a) : a) ===
  (isOrcaSessionId(b) ? canonicalOrcaSessionId(b) : b)

/** `callerSessionId`: the session the request came from, when Orca knows it. */
export async function botTurnFor(
  runtime: OrcaRuntimeService,
  sessionId: string,
  callerSessionId: string | undefined
): Promise<ConnectorTurnFor> {
  if (callerSessionId !== undefined && !sameSession(callerSessionId, sessionId)) {
    return 'none'
  }
  try {
    const { turn } = await readBotTurn(runtime, runtime.getOrchestrationDb(), sessionId)
    return actsForOwner(turn.askers) ? 'owner' : 'someone_else'
  } catch (error) {
    console.warn('[bots] could not read whom a turn acts for', error)
    return 'someone_else'
  }
}
