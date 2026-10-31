import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity,
  AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import type { openAgentSessionJournal } from './journal-store-factory'
import {
  createTrackedJournalOpener,
  openTestJournalHostDatabase
} from './journal-host-database-test-support'
import type Database from '../../sqlite/sync-database'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'

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

  async function withJournalDatabase(
    stateDirectory: string,
    run: (db: Database.Database) => void
  ): Promise<void> {
    const opened = openTestJournalHostDatabase(stateDirectory)
    try {
      run(opened.db)
    } finally {
      await opened.close()
    }
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
    withJournalDatabase
  }
}
