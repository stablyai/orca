// Whom a request a bot's turn sends acts for, and who asked a turn a bot request opened, as Orca
// records them on the request for the bot it asks.
import type { AgentJournalRenderItem } from '../../shared/agent-session/journal/agent-session-journal-types'
import {
  distinctAskers,
  OWNER_ACTS_FOR,
  type BotRequestAsker
} from '../../shared/bots/bot-acts-for'
import type { BotActingTurn, BotRequestActsFor } from './bot-request-asker'
import { typedInOrcaByPerson, typedOnAnotherDevice, type PersonSends } from './bot-typed-in-orca'

/** The turn's askers, and someone Orca can't name when a paired device it can't place as the owner
 *  typed in the turn, so the receiving bot never reads the request as the owner's. */
export function requestAskersOf(
  turn: Pick<BotActingTurn, 'askers' | 'typedByAnother'>
): BotRequestAsker[] {
  return turn.typedByAnother === true
    ? distinctAskers([...turn.askers, { kind: 'unknown' }])
    : turn.askers
}

/** The turn, also acting for whom a paired computer's sending turn acted for. They join its own
 *  askers, never replace them, and a mixed list is held to its least trusted: never wider. */
export function withCarriedAskers<T extends Pick<BotActingTurn, 'askers' | 'askedBy'>>(
  turn: T,
  carried: readonly BotRequestAsker[] = []
): T {
  return carried.length === 0
    ? turn
    : {
        ...turn,
        askers: distinctAskers([...turn.askers, ...carried]),
        askedBy: distinctAskers([...turn.askedBy, ...carried])
      }
}

/** Who asked a turn bot requests opened (`records`, as Orca keeps them): who each request records,
 *  the owner when they typed in the turn themselves, and someone Orca can't name for a paired
 *  device it can't place as the owner. A status asks for no work, so beside anyone who typed in the
 *  turn it asked for none of it; alone, it is still who asked. */
export function requestTurnAskedBy(
  records: readonly (BotRequestActsFor | null)[],
  window: readonly AgentJournalRenderItem[],
  sends: PersonSends,
  /** A paired device Orca can't place as the owner typed in the turn, as the turn's read found. */
  typedByAnother: boolean
): BotRequestAsker[] {
  // A device's message is never the owner's: with one in the turn, its stamp is read before any
  // lookup of its send; with none, the turn's read already said so of every message.
  const owner = window.some(
    (item) => (!typedByAnother || !typedOnAnotherDevice(item)) && typedInOrcaByPerson(item, sends)
  )
  return distinctAskers([
    ...records
      .filter((record) => !(owner || typedByAnother) || !record?.wantsNothing)
      .flatMap(
        (record): readonly BotRequestAsker[] =>
          record?.askedBy ?? record?.askers ?? [{ kind: 'unknown' }]
      ),
    ...(owner ? OWNER_ACTS_FOR : []),
    ...(typedByAnother ? [{ kind: 'unknown' as const }] : [])
  ])
}
