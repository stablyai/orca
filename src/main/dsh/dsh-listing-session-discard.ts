import { readdir, rm, rmdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { AcpListingSession } from '../acp/discovery/acp-model-discovery-policy'

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** DSH cannot delete sessions over ACP, so a model listing's own session is removed from
 *  `$DSH_HOME/sessions/<project>/<sessionId>` once its process exits. */
export async function discardDshListingSession({
  sessionId,
  accountHomePath
}: AcpListingSession): Promise<void> {
  if (!SESSION_ID.test(sessionId)) {
    return
  }
  const sessionsRoot = join(accountHomePath, 'sessions')
  const projects = await readdir(sessionsRoot, { withFileTypes: true }).catch(() => [])
  await Promise.all(
    projects
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const projectPath = join(sessionsRoot, entry.name)
        const sessionPath = join(projectPath, sessionId)
        try {
          await rm(sessionPath, { recursive: true })
          // Remove the temporary project folder if the listing session was its only entry.
          await rmdir(projectPath).catch(() => {})
        } catch {
          // Ignore projects that do not contain this listing session.
        }
      })
  )
}
