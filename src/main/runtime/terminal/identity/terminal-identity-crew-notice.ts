import { TERMINAL_IDENTITY_CHANGE, type CrewChanges } from '../../orchestration/crew/crew-changes'
import { TerminalIdentitySource } from './terminal-identity-source'

/** The runtime's terminal records, telling crews of each write as an `identity` change: a crew
 *  rebuilds only when its own panes and handles resolve differently, never per graph publish. */
export function createCrewNotifiedTerminalIdentity(changes: CrewChanges): TerminalIdentitySource {
  return new TerminalIdentitySource(() => changes.notify(TERMINAL_IDENTITY_CHANGE))
}
