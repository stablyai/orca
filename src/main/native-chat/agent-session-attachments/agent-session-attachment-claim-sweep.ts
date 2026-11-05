import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { isDefinitiveAbsence } from '../../../shared/definitive-filesystem-absence'
import type { AgentSessionAttachmentStore } from './agent-session-attachment-store'
import type { AgentSessionAttachmentSweepFacts } from './agent-session-attachment-sweep'

/** Release discovery before filesystem work; nonreused identities freeze this invocation's membership. */
export async function sweepAttachmentClaims(
  store: AgentSessionAttachmentStore,
  facts: AgentSessionAttachmentSweepFacts
): Promise<void> {
  const db = facts.database()
  if (!db) {
    return
  }
  const upper = await db.scan(
    async (read) =>
      (
        await read
          .prepare(`SELECT CAST(c.claim_id AS TEXT) AS claim_id
      FROM agent_session_attachment_claims AS c ORDER BY c.claim_id DESC LIMIT 1`)
          .get()
      )?.claim_id
  )
  if (typeof upper !== 'string') {
    return
  }
  let after = '0'
  for (;;) {
    if (facts.database() !== db) {
      return
    }
    const page = await db.scan((read) =>
      read
        .prepare(`SELECT CAST(c.claim_id AS TEXT) AS claim_id, upload_id, session_id
        FROM agent_session_attachment_claims AS c
        WHERE c.claim_id > CAST(? AS INTEGER) AND c.claim_id <= CAST(? AS INTEGER)
        ORDER BY c.claim_id LIMIT 32`)
        .all(after, upper)
    )
    if (!page.length || facts.database() !== db) {
      return
    }
    const last = page.at(-1)!
    if (typeof last.claim_id !== 'string') {
      throw new Error('attachment claim identity missing')
    }
    after = last.claim_id
    const failure = await db.transaction(async (plan) => {
      const pairs: { uploadId: string; sessionId: string }[] = []
      let failure: { error: unknown } | undefined
      try {
        const ids = facts.recordedSessionIds()
        for (const row of page) {
          if (
            typeof row.claim_id !== 'string' ||
            typeof row.upload_id !== 'string' ||
            typeof row.session_id !== 'string'
          ) {
            continue
          }
          const pair = { uploadId: row.upload_id, sessionId: row.session_id }
          const current = await plan.read
            .prepare(`SELECT 1 FROM agent_session_attachment_claims
              WHERE upload_id = ? AND session_id = ? AND claim_id = CAST(? AS INTEGER)`)
            .get(pair.uploadId, pair.sessionId, row.claim_id)
          if (!current) {
            continue
          }
          let gone = ids !== null && !ids.has(pair.sessionId)
          if (!gone) {
            try {
              await lstat(join(store.rootDir, pair.uploadId))
            } catch (error) {
              if (!isDefinitiveAbsence(error)) {
                throw error
              }
              gone = true
            }
          }
          if (gone) {
            pairs.push(pair)
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
}
