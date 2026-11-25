import { access } from 'node:fs/promises'
import {
  journalDatabasePath,
  journalDomainDatabasePath
} from '../../../native-chat/agent-session-journal/database/journal-host-database'

/** Non-blocking existence check so async callers skip spawning journal workers on empty profiles.
 *  Lives apart from the record-store slot so the host-refusal gate can use it without an import cycle. */
export async function hasPersistedStructuredAgentSessionDatabaseFile(
  stateDirectory: string
): Promise<boolean> {
  for (const candidate of [
    journalDomainDatabasePath(stateDirectory),
    journalDatabasePath(stateDirectory)
  ]) {
    try {
      await access(candidate)
      return true
    } catch {
      // Absent file; check the next candidate.
    }
  }
  return false
}
