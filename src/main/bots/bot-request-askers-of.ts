// Whom a request a bot's turn sends acts for, and who asked a turn a bot request opened, as Orca
// records them on the request for the bot it asks.
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../shared/agent-session/journal/agent-session-journal-types'
import {
  distinctAskers,
  OWNER_ACTS_FOR,
  type BotRequestAsker
} from '../../shared/bots/bot-acts-for'
import type { BotActingTurn, BotRequestActsFor } from './bot-request-asker'
import { typedInOrcaByPerson, typedOnAnotherDevice } from './bot-typed-in-orca'

/** The turn's askers, and someone Orca can't name when a paired device it can't place as the owner
 *  typed in the turn, so the receiving bot never reads the request as the owner's. */
export function requestAskersOf(
  turn: Pick<BotActingTurn, 'askers' | 'typedByAnother'>
): BotRequestAsker[] {
  return turn.typedByAnother === true
    ? distinctAskers([...turn.askers, { kind: 'unknown' }])
    : turn.askers
}

/** Who asked a turn bot requests opened (`records`, as Orca keeps them): who each request records,
 *  the owner when they typed in the turn themselves, and someone Orca can't name for a paired
 *  device it can't place as the owner. A status asks for no work, so beside anyone who typed in the
 *  turn it asked for none of it; alone, it is still who asked. */
export function requestTurnAskedBy(
  records: readonly (BotRequestActsFor | null)[],
  window: readonly AgentJournalRenderItem[],
  submissions: readonly AgentJournalSubmission[]
): BotRequestAsker[] {
  const another = window.some(typedOnAnotherDevice)
  const owner = window.some(
    (item) => typedInOrcaByPerson(item, submissions) && !typedOnAnotherDevice(item)
  )
  return distinctAskers([
    ...records
      .filter((record) => !(owner || another) || !record?.wantsNothing)
      .flatMap(
        (record): readonly BotRequestAsker[] =>
          record?.askedBy ?? record?.askers ?? [{ kind: 'unknown' }]
      ),
    ...(owner ? OWNER_ACTS_FOR : []),
    ...(another ? [{ kind: 'unknown' as const }] : [])
  ])
}
