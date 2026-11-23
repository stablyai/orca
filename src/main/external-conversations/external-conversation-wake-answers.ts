// Where a chat's self-started turn (a background run's wake-up) answers: the conversation every run
// the wake-up names was launched for. A run is the conversation's when the root agent launched it in
// a turn whose every input by then was a message that conversation delivered, as the launching turn's
// own journal row recorded at that moment. A wake-up answers by its final words only; one that names
// nothing, a run whose launch can't be found, or any other run, stays in Orca.
import type { ExternalConversationLink } from '../../shared/connectors/external-conversation-link'
import type { EndedChatTurn, EndedTurnLaunch } from './external-conversation-ended-turn'

type Conversation = Pick<ExternalConversationLink, 'source' | 'externalId'>

/** The launching turn had taken only messages the conversation delivered. A launch in a wake-up (a
 *  run's finish among its inputs) is no one's: a follow-up's answer stays in Orca. */
function launchedFor(link: Conversation, launch: EndedTurnLaunch): boolean {
  return (
    launch.sends.length > 0 &&
    launch.runs.length === 0 &&
    launch.sends.every(
      (from) => from?.source === link.source && from.externalId === link.externalId
    )
  )
}

/** The ended turn is the chat waking itself for runs launched for its conversation, with no one
 *  steering into it: each run it names has a launch found, and every launch of it is the
 *  conversation's. */
export function wokenTurn(turn: Pick<EndedChatTurn, 'wake'>, link: Conversation): boolean {
  const wake = turn.wake
  if (!wake || wake.steered || wake.wokenBy.length === 0) {
    return false
  }
  return wake.wokenBy.every((run) => {
    const launches = wake.launches.filter((launch) => launch.run === run)
    return launches.length > 0 && launches.every((launch) => launchedFor(link, launch))
  })
}
