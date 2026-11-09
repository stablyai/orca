import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect } from 'vitest'
import {
  agentSessionJournalProviderHandle,
  codexProviderHandle
} from '../../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'
import {
  createTrackedJournalOpener,
  openTestJournalHostDatabase
} from '../store-lifecycle/journal-host-database-test-support'
import { seedTestJournalHistoricalRows } from '../replay/journal-historical-inputs.test-support'
import type { JournalRow } from '../durable-rows/journal-row-schema'
import type { AgentSessionJournal } from '../journal-store'

export function createFixture() {
  const journals = createTrackedJournalOpener()
  const identity = { provider: 'orca' as const, clientMessageId: 'old-turn' }
  const savedIdentity = {
    sessionId: 'validation',
    workspaceId: 'folder',
    hostId: 'host',
    agent: 'codex' as const,
    providerHandle: codexProviderHandle('thread')
  }
  let root: string
  let journal: AgentSessionJournal
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-settlement-validation-'))
  })
  afterEach(async () => {
    await journals.closeAll()
    await rm(root, { recursive: true, force: true })
  })
  async function saveOldItems(inputs: { itemId: string; revision?: number; body: unknown }[]) {
    const epoch = 'saved-approval'
    const rows: JournalRow[] = [
      {
        v: 3,
        kind: 'epoch',
        epoch,
        seq: 1,
        ts: 900,
        fence: 7,
        reason: 'session_created',
        providerHandle: agentSessionJournalProviderHandle(savedIdentity.providerHandle)
      }
    ]
    for (const [index, input] of inputs.entries()) {
      rows.push({
        v: 3,
        kind: 'item',
        epoch,
        seq: index + 2,
        ts: 900,
        fence: 7,
        revision: 1,
        ...input,
        turnScope: { kind: 'thread' }
      } as JournalRow)
    }
    seedTestJournalHistoricalRows(openTestJournalHostDatabase(root).db, savedIdentity, rows)
    journal = await journals.open({
      identity: savedIdentity,
      stateDirectory: root,
      now: () => 1_000
    })
  }
  async function expectSendStillWritable() {
    const sequence = journal.cursor().sequence + 1
    await expect(
      journal.appendSubmission({
        clientMessageId: 'new-send',
        payloadFingerprint: 'new',
        fence: 8,
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hello' }] }
      })
    ).resolves.toMatchObject({ sequence })
  }
  function pendingApproval() {
    return {
      kind: 'approval',
      title: 'Allow?',
      detail: null,
      options: [],
      resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
    }
  }
  return {
    identity,
    get journal() {
      return journal
    },
    saveOldItems,
    pendingApproval,
    expectSendStillWritable
  }
}
