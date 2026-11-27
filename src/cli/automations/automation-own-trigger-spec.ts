// from=me on an --on rule: the bot's owner. On GitHub the bot works as them, so only a pull request
// they open may start one (OWN_EVENT_KINDS).
import {
  takesOwnEvents,
  type AutomationConnectorEventTrigger
} from '../../shared/automation-event-triggers'
import { RuntimeClientError } from '../runtime/connection/types'

const OWNER_WORD = 'me'
const isOwnerWord = (who: string) => who.replace(/^@/, '').toLowerCase() === OWNER_WORD

export const OWN_TRIGGER_OPTION =
  '  from=me  github.pr_opened only: pull requests you open start it too (from=me alone: only yours, as for "review my new PRs"; from=me,@dana: yours and Dana\'s)'

/** from= as the people it names (as written: the host looks names up as ids) and whether it names
 *  you; you only where your own events count. */
export function parseFromPeople(
  spec: string,
  sourceEvent: { source: string; event: string },
  from: string | undefined
): { others: string[] | undefined; fromOwner: boolean } {
  const people = from?.split(',').map((who) => who.trim())
  if (people?.some((who) => !who)) {
    throw new RuntimeClientError(
      'invalid_argument',
      `--on "${spec}" needs from= to list people, separated by commas.`
    )
  }
  const fromOwner = people?.some(isOwnerWord) ?? false
  if (fromOwner && !takesOwnEvents(sourceEvent)) {
    throw new RuntimeClientError(
      'invalid_argument',
      `--on "${spec}": from=me is for github.pr_opened only. The bot works as you, so your own pushes, comments and reviews never start it.`
    )
  }
  return { others: people?.filter((who) => !isOwnerWord(who)), fromOwner }
}

/** The people as written in from= (me first), or as said ("you"); empty when it names no one. */
export function peopleOf(
  trigger: Pick<AutomationConnectorEventTrigger, 'from' | 'fromOwner'>,
  you: string = OWNER_WORD
): string[] {
  return [...(trigger.fromOwner ? [you] : []), ...(trigger.from ?? [])]
}

/** What from=me adds to a rule's id; nothing without it, so rules from before it keep theirs. */
export function ownIdParts(trigger: Pick<AutomationConnectorEventTrigger, 'fromOwner'>): string[] {
  return trigger.fromOwner ? [OWNER_WORD] : []
}
