import type { CrewInvalidation } from '../../crew/crew-changes'
import { parsePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'

/** The sleeping-mail scope a crew change names: its mailboxes, its Dispatches' mailboxes, and the
 *  Runs and panes it names as parties. Undefined only when the change names none of these. */
export function sleepingMailChangeScope(
  facets: CrewInvalidation
): { mailboxes: string[]; panes: string[] } | undefined {
  if (!facets.trafficAddresses && !facets.dispatchIds && !facets.parties) {
    return undefined
  }
  const mailboxes = [...(facets.trafficAddresses ?? [])]
  for (const id of facets.dispatchIds ?? []) {
    mailboxes.push(`dispatch:${id}`)
  }
  const panes: string[] = []
  for (const party of facets.parties ?? []) {
    if (party.startsWith('run:')) {
      mailboxes.push(party)
    } else if (parsePaneKey(party)) {
      panes.push(party)
    }
  }
  return { mailboxes, panes }
}
