import { readStructuredConversationJournalPreviews } from './structured-conversation-journal-preview'
import { migrateJournalDomainSchema } from '../native-chat/agent-session-journal/journal-domain-schema'
import { prepareJournalDomainImport } from '../native-chat/agent-session-journal/journal-domain-import'
import {
  insertJournalDomainImportPage,
  finishJournalDomainImport
} from '../native-chat/agent-session-journal/journal-domain-import-rows'
import { readJournalSqlPoint } from '../native-chat/agent-session-journal/journal-sql-point-read'
import {
  openJournalDatabase,
  runJournalTransaction
} from '../native-chat/agent-session-journal/database/journal-database'
import { agentSessionConversationView } from '../../shared/agent-session/lifecycle/leases/agent-session-conversation-view'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { agentSessionRecordFixture } from '../../shared/agent-session/lifecycle/records/agent-session-record.test-fixture'
import type { AgentSessionRecord } from '../../shared/agent-session/lifecycle/agent-session-record'
import type { AiVaultListResult } from '../../shared/ai-vault/contracts/ai-vault-types'
import type { AgentJournalMessageItem } from '../../shared/agent-session/journal/agent-session-journal-types'
import { setStructuredAgentSessionHost } from '../native-chat/agent-session-wire/host/structured-agent-session-registry'
import {
  insertJournalRow,
  publishJournalSessionEpoch
} from '../native-chat/agent-session-journal/durable-rows/journal-row-table'
import type { JournalRow } from '../native-chat/agent-session-journal/durable-rows/journal-row-schema'
import Database from '../sqlite/sync-database'
import {
  projectStructuredAiVaultSessions,
  OPENS_EVERY_STRUCTURED_CHAT
} from './structured-sessions/structured-session-ownership'
import { listResult } from './structured-sessions/structured-session-ownership.test-support'
import { parseAiVaultListResult } from './listing/session-list-result-validation'

const EMPTY: AiVaultListResult = { sessions: [], issues: [], scannedAt: '2026-10-26T00:00:00Z' }
const EPOCH = 'epoch-1'
let db: Database.Database
let record: AgentSessionRecord

beforeEach(() => {
  db = openJournalDatabase(':memory:').db
  record = agentSessionRecordFixture()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: projection reads only this host's catalog and journal database.
  setStructuredAgentSessionHost({
    deps: {
      store: {
        getRecord: () => record,
        listRecords: () => [record],
        listConversations: () => [agentSessionConversationView(record)]
      },
      journalDatabase: { db }
    }
  } as never)
})
afterEach(() => {
  setStructuredAgentSessionHost(null)
  db.close()
})

function base(seq: number) {
  return { v: 2, epoch: EPOCH, seq, fence: 1, ts: 1000 + seq }
}
function register(reason: 'session_created' | 'legacy_import' = 'session_created') {
  publishJournalSessionEpoch(
    db,
    { sessionId: record.sessionId, workspaceId: record.location.workspaceId },
    EPOCH
  )
  insertJournalRow(db, record.sessionId, {
    ...base(1),
    kind: 'epoch',
    reason,
    providerHandle: { kind: 'opaque', agent: 'claude', value: 'pending' }
  })
}
function item(
  seq: number,
  text: string,
  body: Partial<AgentJournalMessageItem> = {},
  linkage = {}
) {
  insertJournalRow(db, record.sessionId, {
    ...base(seq),
    kind: 'item',
    itemId: `message-${seq}`,
    revision: 1,
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text }], ...body },
    ...linkage
  })
}
async function project(result = EMPTY) {
  const domain = new Database(':memory:')
  migrateJournalDomainSchema(domain)
  try {
    const journalPreviews = await readStructuredConversationJournalPreviews(
      {
        readers: {
          point: async (request) => {
            const prepared = prepareJournalDomainImport(db, record.sessionId)
            if (prepared) {
              runJournalTransaction(domain, () => {
                for (const page of prepared.pages) {
                  insertJournalDomainImportPage(domain, prepared, page)
                }
                finishJournalDomainImport(domain, prepared)
              })
            }
            return readJournalSqlPoint(domain, request)
          }
        }
      },
      [record]
    )
    return projectStructuredAiVaultSessions(result, OPENS_EVERY_STRUCTURED_CHAT, {
      includeStructuredSessions: true,
      journalPreviews
    })
  } finally {
    domain.close()
  }
}
function providerRow(title: string, messageCount = 1) {
  return {
    ...listResult().sessions[0]!,
    agent: 'claude' as const,
    sessionId: 'provider-session-alpha-1',
    title,
    messageCount
  }
}

describe('durable conversation names and bounded content evidence', async () => {
  it('preserves a meaningful provider title through ownership and durable projection, then prefers a saved name', async () => {
    const input = { ...EMPTY, sessions: [providerRow('Investigate the deployment failure')] }
    expect((await project(input)).sessions[0]?.title).toBe('Investigate the deployment failure')
    record.conversationName = 'My saved name'
    expect((await project(input)).sessions[0]?.title).toBe('My saved name')
  })

  it('marks only a registered, intact creation epoch empty, including a saved default label', async () => {
    record.conversationName = 'Claude Chat'
    expect((await project()).sessions[0]).toMatchObject({
      conversationContent: 'unknown',
      title: 'Claude Chat'
    })
    register()
    const result = await project()
    expect(result.sessions[0]).toMatchObject({ conversationContent: 'empty', title: 'Claude Chat' })
    expect(parseAiVaultListResult(result).sessions[0]?.conversationContent).toBe('empty')
  })

  it('derives the first human prompt from the journal while skipping commands, agent mail and child messages', async () => {
    register()
    item(2, 'Mailbox notification', { from: { kind: 'agent', senders: [], orchestration: null } })
    item(3, '/compact', { command: { name: 'compact' } })
    item(4, 'Child task', {}, { agentId: 'child' })
    item(5, 'Проверь настройки проекта')
    item(6, 'Assistant reply', { role: 'assistant' })
    expect((await project()).sessions[0]).toMatchObject({
      conversationContent: 'present',
      firstUserPrompt: 'Проверь настройки проекта',
      title: 'Проверь настройки проекта'
    })
    record.conversationName = 'Saved title'
    expect((await project()).sessions[0]?.title).toBe('Saved title')
  })

  it('does not mark provider conversation or queued recovery evidence empty even if the local epoch has no messages', async () => {
    register()
    for (const session of [
      providerRow('Provider conversation'),
      { ...providerRow('Queued message', 0), queuedMessageCount: 2 }
    ]) {
      expect(
        (await project({ ...EMPTY, sessions: [session] })).sessions[0]?.conversationContent
      ).toBe('present')
    }
  })

  it('does not let an empty local epoch erase uncertain provider-file history', async () => {
    register()
    expect(
      (await project({ ...EMPTY, sessions: [providerRow('Claude Chat', 0)] })).sessions[0]
        ?.conversationContent
    ).toBe('unknown')
  })

  it('keeps an intact creation epoch empty when native turns are proven command metadata only', async () => {
    register()
    const session = {
      ...providerRow('Claude Chat', 3),
      conversationContent: 'empty' as const
    }
    expect(
      (await project({ ...EMPTY, sessions: [session] })).sessions[0]?.conversationContent
    ).toBe('empty')
  })

  it.each(['workspace mismatch', 'missing epoch', 'corrupt row', 'sequence gap', 'adopted-only'])(
    'keeps uncertain history visible: %s',
    async (reason) => {
      if (reason === 'missing epoch') {
        publishJournalSessionEpoch(
          db,
          { sessionId: record.sessionId, workspaceId: record.location.workspaceId },
          EPOCH
        )
      } else {
        register(reason === 'adopted-only' ? 'legacy_import' : 'session_created')
        if (reason === 'workspace mismatch') {
          db.prepare('UPDATE journal_sessions SET workspace_id = ?').run('another-workspace')
        }
        if (reason === 'corrupt row') {
          db.prepare('INSERT INTO journal_rows VALUES (?, ?, ?, ?, ?)').run(
            record.sessionId,
            EPOCH,
            2,
            1002,
            '{broken'
          )
        }
        if (reason === 'sequence gap') {
          item(3, 'Recoverable prompt')
        }
      }
      expect((await project()).sessions[0]?.conversationContent).toBe('unknown')
    }
  )

  it('bounds journal discovery and never calls a bounded prefix empty', async () => {
    register()
    for (let seq = 2; seq <= 42; seq += 1) {
      const row: JournalRow = { ...base(seq), kind: 'tombstone', itemId: `old-${seq}`, revision: 1 }
      insertJournalRow(db, record.sessionId, row)
    }
    item(43, 'Prompt outside the prefix')
    expect((await project()).sessions[0]).toMatchObject({ conversationContent: 'unknown' })
    expect((await project()).sessions[0]?.firstUserPrompt).toBeUndefined()
  })

  it('keeps oversized journal rows unknown instead of loading unbounded output', async () => {
    register()
    item(2, 'large prompt '.repeat(10000))
    expect((await project()).sessions[0]?.conversationContent).toBe('unknown')
  })
})
