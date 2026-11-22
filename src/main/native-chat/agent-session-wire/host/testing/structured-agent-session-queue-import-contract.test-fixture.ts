import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach } from 'vitest'
import type { AgentJournalMessageItem } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import type { JournalRow } from '../../../agent-session-journal/durable-rows/journal-row-schema'
import { codexProviderHandle } from '../../../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'
import { agentSessionSendBodyFingerprint } from '../../../../../shared/agent-session/requests/structured-agent-session-send-mutation'
import { seedTestJournalHistoricalRows } from '../../../agent-session-journal/replay/journal-historical-inputs.test-support'
import {
  createTrackedJournalOpener,
  openTestJournalHostDatabase
} from '../../../agent-session-journal/store-lifecycle/journal-host-database-test-support'

let root: string
const journals = createTrackedJournalOpener()
export const sessionId = 'legacy-queue'
export const identity = {
  sessionId,
  workspaceId: 'workspace-1',
  hostId: 'local',
  agent: 'codex' as const,
  providerHandle: codexProviderHandle('thread')
}
export const sourceHandle = { kind: 'codex' as const, threadId: 'thread' }
export const base = (seq: number) => ({ v: 4, epoch: 'frozen-epoch', seq, fence: 0, ts: 1_000 })
export const founding: JournalRow = {
  ...base(1),
  kind: 'epoch',
  reason: 'session_created',
  providerHandle: sourceHandle
}
export const message = (text: string): AgentJournalMessageItem => ({
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text }]
})
export const db = () => openTestJournalHostDatabase(root).db
export const open = () => journals.open({ identity, stateDirectory: root })
export const seed = (rows: JournalRow[], retained = false) =>
  seedTestJournalHistoricalRows(db(), identity, rows, retained)
export function seedLegacyCard(
  messageId: string,
  body: AgentJournalMessageItem,
  consumedAs: string | null = null
) {
  db()
    .prepare(`INSERT INTO queued_messages(session_id,message_id,position,body_json,fingerprint,created_at,host_instance,state,hold_reason,returned_reason,consumed_as)
    VALUES(?,?,?,?,?,1000,'earlier',?,NULL,NULL,?)`)
    .run(
      sessionId,
      messageId,
      messageId === 'W' ? 1 : 2,
      JSON.stringify(body),
      agentSessionSendBodyFingerprint(sessionId, body),
      consumedAs ? 'dispatched' : 'waiting',
      consumedAs
    )
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-queue-conversion-'))
})
afterEach(async () => {
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})
