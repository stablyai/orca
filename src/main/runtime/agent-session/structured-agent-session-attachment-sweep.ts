import type { JournalSqlDatabase } from '../../native-chat/agent-session-journal/database/journal-sql-database'
import type { AgentSessionAttachmentSweepFacts } from '../../native-chat/agent-session-attachments/agent-session-attachment-sweep'
import type { JournalWriterEffect } from '../../native-chat/agent-session-journal/journal-writer-effects'

/** Filesystem awaits release the writer; each claim decision returns to its sole transaction owner. */
export function structuredAgentSessionAttachmentSweepFacts(
  database: JournalSqlDatabase
): AgentSessionAttachmentSweepFacts {
  const writable = () => !database.readOnly && !database.isClosed
  const sweep = async (operation: Extract<JournalWriterEffect, { kind: 'sweep' }>['operation']) =>
    writable() ? (await database.effects([{ kind: 'sweep', operation }]))[0] : undefined
  return {
    listBeingSwept: async () => {
      const uploads: string[] = []
      let after: string | null = null
      while (writable()) {
        const page = await database.readers.database({ kind: 'attachment-sweeps', after })
        if (page.kind !== 'attachment-sweeps') {
          throw new Error('journal reader returned no attachment sweeps')
        }
        uploads.push(...page.uploadIds)
        if (page.uploadIds.length < 128) {
          break
        }
        after = page.uploadIds.at(-1)!
      }
      return uploads
    },
    markForSweep: async (uploadId, now) => (await sweep({ kind: 'mark', uploadId, now })) === true,
    finishSweep: async (uploadId) => {
      await sweep({ kind: 'finish', uploadId })
    },
    pruneClaims: async () => {
      let after = 0
      while (writable()) {
        const page = await database.readers.database({ kind: 'attachment-claims', after })
        if (page.kind !== 'attachment-claims') {
          throw new Error('journal reader returned no attachment claims')
        }
        if (page.claims.length === 0) {
          break
        }
        await sweep({ kind: 'prune', pairs: page.claims })
        after = page.claims.at(-1)!.rowid
        if (page.claims.length < 128) {
          break
        }
      }
    }
  }
}
