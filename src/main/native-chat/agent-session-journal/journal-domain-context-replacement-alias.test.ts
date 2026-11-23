import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import Database from '../../sqlite/sync-database'
import type { AgentJournalMessageItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { claudeProviderHandle } from '../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'
import { agentSessionSendBodyFingerprint } from '../../../shared/agent-session/requests/structured-agent-session-send-mutation'
import { migrateJournalDomainSchema } from './journal-domain-schema'
import { applyJournalDomainSubmission } from './journal-domain-submission-admission'
import { applyJournalDomainDispatch } from './journal-domain-dispatch'
import { replaceJournalDomainContext } from './journal-domain-context-replacement'
import { ensureAgentSessionAttachmentClaimTables } from '../agent-session-attachments/agent-session-attachment-claims'

const target = { sessionId: 'chat', epoch: 'epoch' }
const now = 1_800_000_000_000
const providerHandle = claudeProviderHandle('provider', null)
const cleanups: (() => void)[] = []
const message = (text: string): AgentJournalMessageItem => ({
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text }]
})

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup()
  }
})

it('lets a later replacement remove a prompt an earlier one moved off its sent row', () => {
  const directory = mkdtempSync(join(tmpdir(), 'orca-replacement-alias-'))
  const db = new Database(join(directory, 'journal.sqlite'))
  cleanups.push(() => {
    db.close()
    rmSync(directory, { recursive: true, force: true })
  })
  migrateJournalDomainSchema(db)
  ensureAgentSessionAttachmentClaimTables(db)
  db.prepare(`INSERT INTO journal_chat_state(session_id,workspace_id,epoch,last_sequence,highest_fence)
    VALUES('chat','workspace','epoch',10,1)`).run()
  const transaction = <T>(run: () => T): T => {
    db.exec('BEGIN IMMEDIATE')
    try {
      const value = run()
      db.exec('COMMIT')
      return value
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
  const body = message('sent from chat')
  transaction(() =>
    applyJournalDomainSubmission(
      db,
      directory,
      target,
      {
        kind: 'submission',
        input: {
          clientMessageId: 'sent',
          body,
          payloadFingerprint: agentSessionSendBodyFingerprint('chat', body),
          fence: 1,
          origin: 'client',
          source: { kind: 'user' },
          handoverRecorded: true
        }
      },
      {
        identity: {
          sessionId: 'chat',
          workspaceId: 'workspace',
          hostId: 'host',
          agent: 'claude',
          providerHandle
        }
      },
      now
    )
  )
  const prompt = { provider: 'claude' as const, sessionId: 'provider', uuid: 'prompt' }
  transaction(() =>
    applyJournalDomainDispatch(
      db,
      target,
      {
        kind: 'dispatch',
        input: { clientMessageId: 'sent', state: 'accepted', providerIdentity: prompt, fence: 1 }
      },
      now + 1
    )
  )
  const replace = (items: { uuid: string; text: string }[], at: number) =>
    transaction(() =>
      replaceJournalDomainContext(
        db,
        target,
        {
          kind: 'epoch-replace',
          reason: 'legacy_import',
          providerHandle: { kind: 'claude', sessionId: 'provider', leafUuid: null },
          fence: 1,
          items: items.map(({ uuid, text }) => ({
            identity: { ...prompt, uuid },
            body: message(text),
            ownerFence: 0
          }))
        },
        at
      )
    )
  replace([{ uuid: 'prompt', text: 'sent from chat' }], now + 2)
  // The terminal later rewound past the prompt, so the next window no longer has it.
  replace([{ uuid: 'other', text: 'asked in the terminal' }], now + 3)
  const rows = db
    .prepare('SELECT item_id FROM journal_items WHERE session_id=? AND epoch=? ORDER BY item_id')
    .all('chat', 'epoch')
    .map((row) => String(row.item_id))
  expect(rows).toEqual(['claude:provider:other'])
})
