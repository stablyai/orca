import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { isDefinitiveAbsence } from '../../../shared/definitive-filesystem-absence'
import type { AgentSessionAttachmentStore } from './agent-session-attachment-store'
import type { AgentSessionAttachmentSweepFacts } from './agent-session-attachment-sweep'

/** A frozen reader bounds membership; only finite, freshly checked pages own writer admission. */
export async function sweepAttachmentClaims(
  store: AgentSessionAttachmentStore,
  facts: AgentSessionAttachmentSweepFacts
): Promise<void> {
  const db = facts.database()
  if (!db) {
    return
  }
  await db.read(async (read) => {
    let after: { uploadId: string; sessionId: string } | undefined
    for (;;) {
      const page = after
        ? await read
            .prepare(`SELECT upload_id, session_id FROM agent_session_attachment_claims
              WHERE (upload_id, session_id) > (?, ?) ORDER BY upload_id, session_id LIMIT 32`)
            .all(after.uploadId, after.sessionId)
        : await read
            .prepare(`SELECT upload_id, session_id FROM agent_session_attachment_claims
              ORDER BY upload_id, session_id LIMIT 32`)
            .all()
      if (!page.length || facts.database() !== db) {
        return
      }
      const failure = await db.transaction(async (plan) => {
        const pairs: { uploadId: string; sessionId: string }[] = []
        let failure: { error: unknown } | undefined
        try {
          const ids = facts.recordedSessionIds()
          for (const row of page) {
            if (typeof row.upload_id !== 'string' || typeof row.session_id !== 'string') {
              continue
            }
            after = { uploadId: row.upload_id, sessionId: row.session_id }
            const current = await plan.read
              .prepare(`SELECT 1 FROM agent_session_attachment_claims
                WHERE upload_id = ? AND session_id = ?`)
              .get(after.uploadId, after.sessionId)
            if (!current) {
              continue
            }
            let gone = ids !== null && !ids.has(after.sessionId)
            if (!gone) {
              try {
                await lstat(join(store.rootDir, after.uploadId))
              } catch (error) {
                if (!isDefinitiveAbsence(error)) {
                  throw error
                }
                gone = true
              }
            }
            if (gone) {
              pairs.push(after)
            }
          }
        } catch (error) {
          failure = { error }
        }
        // Already-proved absence commits even if a later filesystem inspection is uncertain.
        if (pairs.length) {
          plan.add({ kind: 'sweep', operation: { kind: 'prune', pairs } })
        }
        return failure
      })
      if (failure) {
        throw failure.error
      }
    }
  })
}
