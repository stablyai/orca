// Where a chat's self-started turn (a background run's wake-up) answers: the conversation every run
// the wake-up names was launched for. A run is the conversation's when the root agent launched it in
// a turn whose every input so far was a message that conversation delivered, as the agent's journal
// recorded at that moment. Kept on the link so a restart still knows. A wake-up answers by its final
// words only; one that names nothing, or any other run, stays in Orca.
import type { ExternalConversationLink } from '../../shared/connectors/external-conversation-link'
import type { EndedChatTurn, EndedTurnLaunch } from './external-conversation-ended-turn'
import type { LinkedConversation } from './external-conversation-links'

type WakeAnswers = ExternalConversationLink['wakeAnswers']
/** Kept per link, newest last; a run past the cap is no one's, so its wake-up stays in Orca. */
const MAX_WAKE_RUNS = 16

export type WakeAnswersDeps = {
  /** Keeps the runs whose wake-ups answer the link. */
  keepWakeAnswers: (linked: LinkedConversation, wakeAnswers: WakeAnswers) => void
}

/** At a turn's end: the runs it launched for its conversation alone join the link's. */
export function recordLaunches(
  deps: WakeAnswersDeps,
  linked: LinkedConversation,
  launches: readonly EndedTurnLaunch[] | undefined
): void {
  const kept = linked.link.wakeAnswers?.runs ?? []
  const added = (launches ?? [])
    .filter((launch) => !kept.includes(launch.run) && launchedFor(linked.link, launch))
    .map((launch) => launch.run)
  if (added.length > 0) {
    deps.keepWakeAnswers(linked, { runs: [...kept, ...added].slice(-MAX_WAKE_RUNS) })
  }
}

/** The launching turn had taken only messages the conversation delivered. A launch in a wake-up (a
 *  run's finish among its inputs) is no one's: a follow-up's answer stays in Orca. */
function launchedFor(link: ExternalConversationLink, launch: EndedTurnLaunch): boolean {
  return (
    launch.sends.length > 0 &&
    launch.runs.length === 0 &&
    launch.sends.every(
      (from) => from?.source === link.source && from.externalId === link.externalId
    )
  )
}

/** Every run the wake-up names was launched for its conversation. */
function namesOnlyConversationTasks(wakeAnswers: WakeAnswers, wokenBy: readonly string[]): boolean {
  const recorded = new Set(wakeAnswers?.runs ?? [])
  return wokenBy.length > 0 && wokenBy.every((id) => recorded.has(id))
}

/** The ended turn is the chat waking itself for runs launched for its conversation, with no one
 *  steering into it. */
export function wokenTurn(
  turn: Pick<EndedChatTurn, 'wake'>,
  link: Pick<ExternalConversationLink, 'wakeAnswers'>
): boolean {
  return (
    turn.wake !== undefined &&
    !turn.wake.steered &&
    namesOnlyConversationTasks(link.wakeAnswers, turn.wake.wokenBy)
  )
}

/** A chat's turn ends, each read and its launches recorded in turn order, so a wake-up is judged
 *  after the turn that launched its runs recorded them. */
export class TurnEndRecords {
  private readonly last = new Map<string, Promise<void>>()

  read<T>(paneKey: string, read: () => Promise<T>, record: (turn: T) => void): Promise<T> {
    const turn = (this.last.get(paneKey) ?? Promise.resolve()).then(read).then((ended) => {
      record(ended)
      return ended
    })
    const settled = turn.then(
      () => undefined,
      () => undefined
    )
    this.last.set(paneKey, settled)
    return turn
  }

  clear(): void {
    this.last.clear()
  }
}
