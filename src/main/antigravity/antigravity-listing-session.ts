import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { ANTIGRAVITY_ACP_HOME } from '../../shared/agent-session/lifecycle/provider-handles/antigravity-session-origin'
import type { AcpListingSession } from '../acp/discovery/acp-model-discovery-policy'

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const metaSchema = z.looseObject({ cwd: z.string() })
const CONVERSATION_FILES = ['.db', '.db-wal', '.db-shm', '.db-journal', '.meta']

/** agy keeps every session in Orca's chat home; remove the one that listed models. The id is the
 *  listing's own; a `.meta` file (written by Orca's retired server) must also name its folder. */
export async function discardAntigravityListingSession({
  sessionId,
  cwd,
  accountHomePath
}: AcpListingSession): Promise<void> {
  if (!SESSION_ID.test(sessionId)) {
    return
  }
  const home = join(accountHomePath, ANTIGRAVITY_ACP_HOME)
  const conversation = join(home, 'conversations', sessionId)
  const meta = await readFile(`${conversation}.meta`, 'utf8').then(
    (text) => metaSchema.safeParse(JSON.parse(text)).data ?? null,
    () => undefined
  )
  if (meta !== undefined && meta?.cwd !== cwd) {
    return
  }
  await Promise.all([
    ...CONVERSATION_FILES.map((suffix) => rm(`${conversation}${suffix}`, { force: true })),
    rm(join(home, 'brain', sessionId), { recursive: true, force: true }),
    rm(join(home, 'annotations', `${sessionId}.pbtxt`), { force: true })
  ])
}
