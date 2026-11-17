import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { ANTIGRAVITY_ACP_HOME } from '../../shared/agent-session/lifecycle/provider-handles/antigravity-session-origin'
import type { AcpListingSession } from '../acp/discovery/acp-model-discovery-policy'

const metaSchema = z.looseObject({ cwd: z.string() })
const CONVERSATION_FILES = ['.db', '.db-wal', '.db-shm', '.db-journal', '.meta']

/** Orca's Antigravity server keeps every session; remove the one that listed models. */
export async function discardAntigravityListingSession({
  sessionId,
  cwd,
  accountHomePath
}: AcpListingSession): Promise<void> {
  const home = join(accountHomePath, ANTIGRAVITY_ACP_HOME)
  const conversation = join(home, 'conversations', sessionId)
  const meta = metaSchema.safeParse(
    JSON.parse(await readFile(`${conversation}.meta`, 'utf8').catch(() => 'null'))
  )
  if (!meta.success || meta.data.cwd !== cwd) {
    return
  }
  await Promise.all([
    ...CONVERSATION_FILES.map((suffix) => rm(`${conversation}${suffix}`, { force: true })),
    rm(join(home, 'brain', sessionId), { recursive: true, force: true })
  ])
}
