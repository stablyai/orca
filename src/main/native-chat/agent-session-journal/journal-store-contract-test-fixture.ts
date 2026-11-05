import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach } from 'vitest'
import type { AgentJournalItemBody } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type {
  AgentJournalItemIdentity,
  AgentSessionJournalIdentity
} from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type { openAgentSessionJournal } from './journal-store-factory'
import {
  createTrackedJournalOpener,
  openTestJournalHostDatabase,
  deleteTestJournalRow,
  liveTestJournalRows
} from './journal-host-database-test-support'
import { codexProviderHandle } from '../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'

export function createFixture() {
  const IDENTITY: AgentSessionJournalIdentity = {
    sessionId: 'session-1',
    workspaceId: 'ws-1',
    hostId: 'host-1',
    agent: 'codex',
    providerHandle: codexProviderHandle('thread-1')
  }

  let root: string

  let clock = 1_000

  function tick(): number {
    clock += 1
    return clock
  }

  function item(ordinal: number): AgentJournalItemIdentity {
    return { provider: 'codex', threadId: 'thread-1', turnId: 'turn-1', ordinal }
  }

  function body(value: string): AgentJournalItemBody {
    return { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: value }] }
  }

  const journals = createTrackedJournalOpener()

  async function open(overrides: Partial<Parameters<typeof openAgentSessionJournal>[0]> = {}) {
    return journals.open({
      identity: IDENTITY,
      stateDirectory: root,
      now: tick,
      mintEpoch: () => `epoch-${clock}`,
      ...overrides
    })
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-journal-'))
    clock = 1_000
  })

  afterEach(async () => {
    await journals.closeAll()
    await rm(root, { recursive: true, force: true })
  })

  async function savedJournalFacts() {
    const database = await openTestJournalHostDatabase(root)
    return database.read(async (read) => ({
      item: await read
        .prepare("SELECT value_json FROM journal_outcomes WHERE field = 'items'")
        .get(),
      epoch: await read.prepare('SELECT epoch FROM journal_sessions').get()
    }))
  }

  async function deleteSavedJournalRow(sequence: number): Promise<void> {
    await deleteTestJournalRow(
      await openTestJournalHostDatabase(root),
      IDENTITY.sessionId,
      sequence
    )
  }

  async function savedRows() {
    return liveTestJournalRows(await openTestJournalHostDatabase(root), IDENTITY.sessionId)
  }

  return {
    IDENTITY,
    body,
    get clock() {
      return clock
    },
    set clock(value: typeof clock) {
      clock = value
    },
    item,
    journals,
    open,
    get root() {
      return root
    },
    set root(value: typeof root) {
      root = value
    },
    tick,
    savedJournalFacts,
    deleteSavedJournalRow,
    savedRows
  }
}
