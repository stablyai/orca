import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SessionMetadata = z.looseObject({ cwd: z.string() })

/** Call after proven server exit; remove only sessions whose metadata matches the temporary cwd. */
export async function removeAntigravitySignInSessionFiles(
  home: string,
  sessionId: string | undefined,
  cwd: string
): Promise<void> {
  if (!sessionId || !SESSION_ID.test(sessionId)) {
    return
  }
  const acp = join(home, 'antigravity-acp')
  const base = join(acp, 'conversations', sessionId)
  const text = await readFile(`${base}.meta`, 'utf8').catch(() => null)
  if (text === null || SessionMetadata.safeParse(JSON.parse(text)).data?.cwd !== cwd) {
    return
  }
  for (const suffix of ['.db', '.db-wal', '.db-shm', '.db-journal', '.meta']) {
    await rm(`${base}${suffix}`, { force: true })
  }
  await rm(join(acp, 'brain', sessionId), { recursive: true, force: true })
}
