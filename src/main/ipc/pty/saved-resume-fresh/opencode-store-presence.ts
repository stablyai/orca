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
import { shellStartupAssigns, type SavedResumeStoreQuery } from './store-query'

/** OpenCode keeps sessions in one SQLite database of its data folder. Another channel's database,
 *  or legacy file sessions not yet imported, leave which store it reads open, so a miss is unknown. */
export async function openCodeStorePresence(
  query: SavedResumeStoreQuery,
  budget: StoreReadBudget
): Promise<StorePresence> {
  const env = query.launchEnv
  if (
    (env.XDG_DATA_HOME === undefined && shellStartupAssigns('XDG_DATA_HOME', env)) ||
    (env.OPENCODE_DB === undefined && shellStartupAssigns('OPENCODE_DB', env))
  ) {
    return 'unknown'
  }
  const dbPath = resolveOpenCodeDatabasePath(env)
  const dataDirectory = resolveOpenCodeDataDirectory(env)
  if (!dbPath || (await statStoreFile(join(dataDirectory, 'storage', 'session'))) !== 'missing') {
    return 'unknown'
  }
  for await (const entry of listStoreDirectory(dataDirectory, budget)) {
    if (/^opencode.*\.db$/i.test(entry.name) && join(dataDirectory, entry.name) !== dbPath) {
      return 'unknown'
    }
  }
  // The presence request answers with a bare verdict string, not a transcript value.
  const presence: unknown = await getSharedClient().readNativeChat({
    kind: 'native-presence',
    dbPath,
    sessionId: query.providerSession.id
  })
  return presence === 'found' || presence === 'missing' ? presence : 'unknown'
}
