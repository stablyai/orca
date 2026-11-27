import { basename, join } from 'node:path'
import { rm, stat } from 'node:fs/promises'
import { ANTIGRAVITY_ACP_HOME } from '../../shared/agent-session/lifecycle/provider-handles/antigravity-session-origin'
import type { AcpListingSession } from '../acp/discovery/acp-model-discovery-policy'
import { ANTIGRAVITY_AGY_CHAT_HOME_FOLDER } from './antigravity-agy-orca-home'
import { ANTIGRAVITY_CHAT_HOME_FOLDER } from './antigravity-chat-home'

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CONVERSATION_FILES = ['.db', '.db-wal', '.db-shm', '.db-journal']

/** Where agy keeps sessions for each home a listing runs in: agy's own, Orca's, or the retired
 *  server's, whose old chats agy runs in place. */
const APP_DATA_FOLDERS: Record<string, string> = {
  '.gemini': 'antigravity-cli',
  [ANTIGRAVITY_AGY_CHAT_HOME_FOLDER]: ANTIGRAVITY_ACP_HOME,
  [ANTIGRAVITY_CHAT_HOME_FOLDER]: ANTIGRAVITY_ACP_HOME
}

/** agy can't delete sessions over ACP, so a model listing's own session is removed from disk once
 *  its process exits. Its 0-step row stays in agy's summaries index, as for any session agy opens
 *  without a prompt; agy's session list doesn't show it. */
export async function discardAgyListingSession({
  sessionId,
  accountHomePath
}: AcpListingSession): Promise<void> {
  const appData = APP_DATA_FOLDERS[basename(accountHomePath)]
  if (!SESSION_ID.test(sessionId) || !appData) {
    return
  }
  const home = join(accountHomePath, appData)
  const conversation = join(home, 'conversations', sessionId)
  // Only a session that exists here is the listing's; nothing else is touched.
  if (!(await stat(`${conversation}.db`).catch(() => null))) {
    return
  }
  await Promise.all([
    ...CONVERSATION_FILES.map((suffix) => rm(`${conversation}${suffix}`, { force: true })),
    rm(join(home, 'brain', sessionId), { recursive: true, force: true }),
    rm(join(home, 'annotations', `${sessionId}.pbtxt`), { force: true })
  ])
}
