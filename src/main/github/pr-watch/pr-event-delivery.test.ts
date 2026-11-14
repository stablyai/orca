import {
  openTestAgentSessionDatabase,
  withTestAgentSessionDatabase
} from '../../runtime/agent-session/records/agent-session-record-store-test-harness'
import { readTestJournalSnapshot } from '../../native-chat/agent-session-journal/journal-observation.test-support'
import { prWatchStorage } from './pr-watch-storage'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionJournalIdentity } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import { codexProviderHandle } from '../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'
import { createTrackedJournalOpener } from '../../native-chat/agent-session-journal/store-lifecycle/journal-host-database-test-support'
import type { AgentSessionJournal } from '../../native-chat/agent-session-journal/journal-store'
import { deliverPendingPullRequestEvents } from './pr-event-delivery'
import { insertPRCheckEvent } from './pr-check-event-tables'
import { insertPRChatAction } from './pr-watch-tables'

const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: 'chat-1',
  workspaceId: 'ws-1',
  hostId: 'host-1',
  agent: 'codex',
  providerHandle: codexProviderHandle('thread-1')
}
const PR_KEY = 'github.com/acme/repo#3'

let root: string
let clock = 1_000
const journals = createTrackedJournalOpener()

async function lines(journal: AgentSessionJournal): Promise<string[]> {
  return (await readTestJournalSnapshot(journal)).items.flatMap((item) =>
    item.body.kind === 'status' && item.body.presentation === 'pull-request-event'
      ? [item.body.text]
      : []
  )
}

describe('deliverPendingPullRequestEvents', () => {
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'pr-event-delivery-'))
  })

  afterEach(async () => {
    await journals.closeAll()
    await rm(root, { recursive: true, force: true })
  })

  it('appends pending lines oldest first, once, without touching the activity clock', async () => {
    const journal = await journals.open({
      identity: IDENTITY,
      stateDirectory: root,
      now: () => (clock += 1),
      mintEpoch: () => 'epoch-1'
    })
    await journal.appendItem(
      { provider: 'codex', threadId: 'thread-1', turnId: 'turn-1', ordinal: 0 },
      { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'Pushed.' }] },
      { fence: 0, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    const activity = await journal.reads.lastActivityAt()
    const database = prWatchStorage(await openTestAgentSessionDatabase(root))
    await withTestAgentSessionDatabase(root, (db) => {
      db.exec('BEGIN IMMEDIATE')
      insertPRChatAction(db, {
        chatId: 'chat-1',
        anchor: { itemId: 'codex:thread-1:turn-1:0', revision: 1 },
        forgeHost: 'github.com',
        owner: 'acme',
        repo: 'repo',
        number: 3,
        kind: 'pushed',
        headSha: '8d5f74b3c0e1d2f3',
        observedAt: 0
      })
      for (const [headSha, verdict] of [
        ['8d5f74b3c0e1d2f3', 'failure'],
        ['c512e75aa0b1c2d3', 'success']
      ] as const) {
        insertPRCheckEvent(db, {
          prKey: PR_KEY,
          headSha,
          verdict,
          observedAt: 10,
          isCurrentHead: true
        })
      }
      db.exec('COMMIT')
    })

    await deliverPendingPullRequestEvents({ database, journal, sessionId: 'chat-1', fence: 0 })
    await deliverPendingPullRequestEvents({ database, journal, sessionId: 'chat-1', fence: 0 })

    expect(await lines(journal)).toEqual([
      'CI failing on repo#3 at 8d5f74b',
      'CI green on repo#3 at c512e75'
    ])
    expect(await database.read({ kind: 'oldest-delivery', chatId: 'chat-1' })).toBeNull()
    expect(await journal.reads.lastActivityAt()).toBe(activity)
  })

  it('writes the line and marks it delivered in one transaction', async () => {
    const journal = await journals.open({
      identity: IDENTITY,
      stateDirectory: root,
      now: () => (clock += 1),
      mintEpoch: () => 'epoch-1'
    })
    const database = prWatchStorage(await openTestAgentSessionDatabase(root))
    await withTestAgentSessionDatabase(root, (db) => {
      db.exec('BEGIN IMMEDIATE')
      insertPRChatAction(db, {
        chatId: 'chat-1',
        anchor: { itemId: 'orca:anchor', revision: 1 },
        forgeHost: 'github.com',
        owner: 'acme',
        repo: 'repo',
        number: 3,
        kind: 'opened',
        headSha: null,
        observedAt: 0
      })
      insertPRCheckEvent(db, {
        prKey: PR_KEY,
        headSha: '8d5f74b3c0e1d2f3',
        verdict: 'failure',
        observedAt: 10,
        isCurrentHead: true
      })
      db.exec('COMMIT')
    })
    // The delivered mark fails inside the append's transaction, so the line must roll back too.
    await withTestAgentSessionDatabase(root, (db) =>
      db.exec(`CREATE TRIGGER fail_delivery BEFORE UPDATE ON pr_event_deliveries
      BEGIN SELECT RAISE(ABORT, 'mark failed'); END`)
    )

    await expect(
      deliverPendingPullRequestEvents({ database, journal, sessionId: 'chat-1', fence: 0 })
    ).rejects.toThrow('mark failed')
    expect(await lines(journal)).toEqual([])
    expect((await database.read({ kind: 'oldest-delivery', chatId: 'chat-1' }))?.verdict).toBe(
      'failure'
    )
  })
})
