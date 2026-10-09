import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import { claudeProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import {
  createTrackedJournalOpener,
  openTestJournalHostDatabase
} from '../agent-session-journal/journal-host-database-test-support'
import { readQueuedMessagesPage } from './structured-agent-session-queue-page'
import { readQueuedMessageBody } from './structured-agent-session-queue-body'
import { readQueueSummary } from './structured-agent-session-queue-summary'

export const PAGE_SESSION = 'queue-page-tests'
export const PAGE_GATE = () => ({ record: null, fence: 0 })
export const PAGE_ENVELOPE = { id: 'request-"\\🦦', runtimeId: 'runtime-漢' }
export function pageMessage(text: string): AgentJournalMessageItem {
  return { kind: 'message', role: 'user', blocks: [{ type: 'text', text }] }
}

export async function queuePageRig() {
  const root = await mkdtemp(join(tmpdir(), 'orca-queue-pages-'))
  const journals = createTrackedJournalOpener()
  let epoch = 0
  const open = () =>
    journals.open({
      identity: {
        sessionId: PAGE_SESSION,
        workspaceId: 'folder',
        hostId: 'host',
        agent: 'claude',
        providerHandle: claudeProviderHandle('native', null)
      },
      stateDirectory: root,
      mintEpoch: () => `epoch-${++epoch}`
    })
  let journal = await open()
  let db = openTestJournalHostDatabase(root).db
  const insert = (messageId: string, body = pageMessage(messageId)) =>
    journal.queuedMessages.insert({
      messageId,
      body,
      fingerprint: `fp-${messageId}`,
      hostInstance: 'host'
    })
  const seed = (count: number, body = pageMessage('x')) => {
    db.prepare(`WITH RECURSIVE cards(n) AS (VALUES(1) UNION ALL SELECT n + 1 FROM cards WHERE n < ?)
      INSERT INTO queued_messages (session_id, message_id, position, body_json, fingerprint, created_at, host_instance, state)
      SELECT ?, printf('card-%05d', n), n / 3, ?, 'fp', 1, 'host', 'waiting' FROM cards`).run(
      count,
      PAGE_SESSION,
      JSON.stringify(body)
    )
    journal.queuedMessages.invalidate()
  }
  const wrapped = (result: unknown) => ({
    id: PAGE_ENVELOPE.id,
    ok: true,
    result,
    _meta: { runtimeId: PAGE_ENVELOPE.runtimeId }
  })
  return {
    get journal() {
      return journal
    },
    get db() {
      return db
    },
    reopen: async () => {
      await journals.closeAll()
      journal = await open()
      db = openTestJournalHostDatabase(root).db
    },
    insert,
    seed,
    wrapped,
    page: (
      params: Omit<Parameters<typeof readQueuedMessagesPage>[2], 'sessionId'> = {},
      envelope = PAGE_ENVELOPE
    ) =>
      readQueuedMessagesPage(journal, PAGE_GATE, { sessionId: PAGE_SESSION, ...params }, envelope),
    body: (
      messageId: string,
      params: Omit<Parameters<typeof readQueuedMessageBody>[2], 'sessionId' | 'messageId'> = {},
      envelope = PAGE_ENVELOPE
    ) =>
      readQueuedMessageBody(
        journal,
        PAGE_GATE,
        { sessionId: PAGE_SESSION, messageId, ...params },
        envelope
      ),
    summary: () => readQueueSummary(journal, PAGE_GATE).queueSummary,
    close: async () => {
      await journals.closeAll()
      await rm(root, { recursive: true, force: true })
    }
  }
}

export type QueuePageRig = Awaited<ReturnType<typeof queuePageRig>>
