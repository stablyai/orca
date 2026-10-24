import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemBody,
  type AgentJournalItemIdentity,
  type AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import type { JournalHostDatabase } from './journal-host-database'
import {
  createTrackedJournalOpener,
  liveTestJournalRows,
  openTestJournalHostDatabase
} from './journal-host-database-test-support'
import type { AgentSessionJournal } from './journal-store'

export function registerJournalItemProvenanceTests(): void {
  const IDENTITY: AgentSessionJournalIdentity = {
    sessionId: 'session-1',
    workspaceId: 'ws-1',
    hostId: 'host-1',
    agent: 'codex',
    providerHandle: codexProviderHandle('thread-1')
  }
  const SCOPE = AGENT_JOURNAL_THREAD_SCOPE
  const TURN: AgentJournalItemIdentity = {
    provider: 'codex',
    threadId: 'thread-1',
    turnId: 'turn-1',
    ordinal: 1
  }
  const TURN_ID = agentJournalItemKey(TURN)
  const RUNNING: AgentJournalItemBody = { kind: 'turn', turnId: 'turn-1', state: 'running' }
  const SETTLED: AgentJournalItemBody = { kind: 'turn', turnId: 'turn-1', state: 'interrupted' }

  let root: string
  let database: JournalHostDatabase
  const journals = createTrackedJournalOpener()

  function item(ordinal: number): AgentJournalItemIdentity {
    return { provider: 'codex', threadId: 'thread-1', turnId: 'turn-1', ordinal }
  }

  type StoredItemWrite = { kind?: string; ownerFence?: number; mutations?: StoredItemWrite[] }

  function storedOwnerFences(): (number | undefined)[] {
    return liveTestJournalRows(database.db, IDENTITY.sessionId).flatMap((row) => {
      const parsed: StoredItemWrite = JSON.parse(row.rowJson)
      const writes = parsed.kind === 'lifecycle-batch' ? (parsed.mutations ?? []) : [parsed]
      return writes.flatMap((write) => (write.kind === 'item' ? [write.ownerFence] : []))
    })
  }

  async function open(): Promise<AgentSessionJournal> {
    return journals.open({ identity: IDENTITY, stateDirectory: root })
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-journal-provenance-'))
    database = openTestJournalHostDatabase(root)
  })

  afterEach(async () => {
    await journals.closeAll()
    await rm(root, { recursive: true, force: true })
  })

  describe('execution provenance', () => {
    it("records the creating observation's owner, every revision keeps it, and a reopen reads it", async () => {
      const journal = await open()
      await journal.appendItem(TURN, RUNNING, { fence: 4, ownerFence: 3, turnScope: SCOPE })
      await journal.appendItem(TURN, RUNNING, { fence: 5, ownerFence: 5, turnScope: SCOPE })
      await journal.appendItem(TURN, SETTLED, { fence: 5, turnScope: SCOPE })
      await journal.appendItem(
        item(2),
        { kind: 'status', text: 'note' },
        { fence: 6, turnScope: SCOPE }
      )

      expect(journal.itemFence(TURN_ID)).toBe(3)
      expect(journal.itemFence(agentJournalItemKey(item(2)))).toBe(6)
      expect(storedOwnerFences()).toEqual([3, 3, 3, 6])
      await journals.closeAll()
      expect((await open()).itemFence(TURN_ID)).toBe(3)
    })

    it('a lifecycle batch states it on each item: the batch owner, else the kept value', async () => {
      const journal = await open()
      await journal.appendItem(TURN, RUNNING, { fence: 2, ownerFence: 2, turnScope: SCOPE })
      await journal.appendLifecycleBatch({
        settlementId: 'provider',
        fence: 3,
        ownerFence: 3,
        mutations: [{ kind: 'item', identity: item(2), body: RUNNING, turnScope: SCOPE }]
      })
      await journal.appendLifecycleBatch({
        settlementId: 'settlement',
        fence: 4,
        recovered: true,
        mutations: [{ kind: 'item', identity: TURN, body: SETTLED, turnScope: SCOPE }]
      })

      expect(journal.itemFence(TURN_ID)).toBe(2)
      expect(journal.itemFence(agentJournalItemKey(item(2)))).toBe(3)
      expect(storedOwnerFences()).toEqual([2, 3, 2])
    })
  })
}
