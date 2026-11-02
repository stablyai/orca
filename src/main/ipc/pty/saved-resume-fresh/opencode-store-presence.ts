import { join } from 'node:path'
import {
  resolveOpenCodeDataDirectory,
  resolveOpenCodeDatabasePath
} from '../../../opencode/opencode-data-directory'
import { getSharedClient } from '../../../ai-vault/session-scanner-opencode-sqlite-worker-spawn'
import {
  listStoreDirectory,
  statStoreFile,
  type StorePresence,
  type StoreReadBudget
} from './store-walk'
import { reportedHome, type SavedResumeStoreQuery } from './store-query'

/** OpenCode keeps sessions in one SQLite database of its data folder. Another channel's database,
 *  or legacy file sessions not yet imported, leave which store it reads open, so a miss is unknown. */
export async function openCodeStorePresence(
  query: SavedResumeStoreQuery,
  budget: StoreReadBudget
): Promise<StorePresence> {
  const home = reportedHome(query.roots)
  if (!home) {
    return 'unknown'
  }
  const dbPath = resolveOpenCodeDatabasePath(query.roots, home)
  const dataDirectory = resolveOpenCodeDataDirectory(query.roots, home)
  if (!dbPath || (await statStoreFile(join(dataDirectory, 'storage', 'session'))) !== 'missing') {
    return 'unknown'
  }
  for await (const entry of listStoreDirectory(dataDirectory, budget)) {
    if (/^opencode.*\.db$/i.test(entry.name) && join(dataDirectory, entry.name) !== dbPath) {
      return 'unknown'
    }
  }
  // The presence request answers with a bare verdict string, not a transcript value.
  const presence: unknown = await getSharedClient().readNativeChat(
    { kind: 'native-presence', dbPath, sessionId: query.providerSession.id },
    AbortSignal.timeout(Math.max(0, budget.deadline - Date.now()))
  )
  return (presence === 'found' || presence === 'missing') && Date.now() <= budget.deadline
    ? presence
    : 'unknown'
}
