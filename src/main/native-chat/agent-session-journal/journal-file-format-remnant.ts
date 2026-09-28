// A journal directory left behind by the pre-SQLite file format.
//
// Not `journal-legacy-import.ts`, which reads the PROVIDER's own transcript.
// This is Orca's own `log.jsonl`, which no build after the SQLite move reads.
// Nothing imports it, so the session it belonged to opens empty and is
// indistinguishable from a chat created seconds ago — same `session_created`
// epoch, same empty timeline. The remnant is the one durable fact that tells
// them apart, so the empty session says where its history went and how to carry
// on instead of silently claiming it never had any.

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentJournalItemIdentity } from '../../../shared/agent-session-journal-types'
import { boundJournalStatusText } from './journal-prompt-body-bounds'
import { formatAgentTypeLabel } from '../../../shared/agent-type-label'
import type { AgentType } from '../../../shared/agent-status-types'

/** The remnant's transcript, or null when the directory never held one.
 *
 *  `log.jsonl` first, and the order matters: every epoch roll staged a
 *  `snapshot.json` whether or not anything was ever compacted into it, so the
 *  file's existence says nothing about where the history lives. Measured across
 *  a real profile, `compactedThrough` was 0 in all 80 — the log holds the
 *  transcript and the snapshot is the fallback for a session that has no log. */
export function findJournalFileFormatRemnant(journalDir: string): string | null {
  for (const name of ['log.jsonl', 'snapshot.json']) {
    const path = join(journalDir, name)
    if (existsSync(path)) {
      return path
    }
  }
  return null
}

/** One stable identity, so a reopen upserts the same row instead of adding one. */
export const JOURNAL_FILE_FORMAT_REMNANT_DISCLOSURE_IDENTITY: AgentJournalItemIdentity = {
  provider: 'orca',
  clientMessageId: 'journal-file-format-remnant'
}

/** How to carry on. The session attaches on the record's own provider handle, so it
 *  still names the conversation the transcript no longer shows — whether the provider
 *  itself still holds that thread is its own business, hence "points at". */
export function journalFileFormatRemnantDisclosure(input: {
  transcriptPath: string
  agent: AgentType
}): { identity: AgentJournalItemIdentity; body: { kind: 'status'; text: string } } {
  return {
    identity: JOURNAL_FILE_FORMAT_REMNANT_DISCLOSURE_IDENTITY,
    body: {
      kind: 'status',
      text: boundJournalStatusText(
        `This chat's history was saved in an older format Orca no longer reads, so it starts ` +
          `empty. The session still points at the same ${formatAgentTypeLabel(input.agent)} ` +
          `conversation — send a message to pick up where you left off. The original ` +
          `transcript is on the session's host at \`${input.transcriptPath}\``
      )
    }
  }
}
