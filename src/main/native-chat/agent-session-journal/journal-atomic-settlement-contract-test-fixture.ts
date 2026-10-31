import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, vi } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { settleObservedExitForTest } from '../agent-session-wire/structured-agent-session-observed-exit.test-fixture'
import {
  createTrackedJournalOpener,
  openTestJournalHostDatabase,
  readTestJournalRows
} from './journal-host-database-test-support'
import { parseJournalRow } from './journal-row-schema'
import type { AgentSessionJournal } from './journal-store'

export function createFixture() {
  const SESSION = 'atomic-settlement'

  const journals = createTrackedJournalOpener({ legacyInputs: true })

  let root: string

  let journal: AgentSessionJournal

  async function open(sessionId = SESSION) {
    return journals.open({
      identity: {
        sessionId,
        workspaceId: 'folder-workspace',
        hostId: 'host',
        agent: 'codex',
        providerHandle: codexProviderHandle('thread')
      },
      stateDirectory: root,
      now: () => 1_000
    })
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-atomic-settlement-'))
    journal = await open()
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await journals.closeAll()
    await rm(root, { recursive: true, force: true })
  })

  function rows() {
    return readTestJournalRows(openTestJournalHostDatabase(root).db, SESSION, journal.epoch).map(
      (stored) => {
        const parsed = parseJournalRow(stored.rowJson)
        if (!parsed.ok) {
          throw new Error('test row failed to parse')
        }
        return parsed.row
      }
    )
  }

  async function seedWork(count = 201) {
    await journal.appendSubmission({
      clientMessageId: 'send',
      payloadFingerprint: 'fingerprint',
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'continue' }] },
      fence: 7
    })
    const turn = await journal.appendItem(
      { provider: 'orca', clientMessageId: 'turn' },
      { kind: 'turn', turnId: 'turn', state: 'running', startedAt: 900 },
      { fence: 7, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    for (let index = 0; index < count; index++) {
      await journal.appendItem(
        { provider: 'orca', clientMessageId: `call-${index}` },
        {
          kind: 'tool-call',
          name: 'Write',
          input: { content: index === 0 ? '界😀'.repeat(220_000) : 'small' },
          state: 'running'
        },
        {
          fence: 7,
          turnScope: { kind: 'turn', turnItemId: turn.itemId },
          agentId: 'child',
          producerKind: 'agent'
        }
      )
    }
  }

  function settle() {
    return settleObservedExitForTest({
      journal,
      sessionId: SESSION,
      fence: 7,
      settlementId: `exit:${SESSION}:7`,
      verdict: { state: 'interrupted', completedAt: 1_000 },
      pendingSubmissionReason: 'provider_exited_before_acknowledgement',
      showUnexpectedExitOutcome: true
    })
  }

  return {
    SESSION,
    get journal() {
      return journal
    },
    set journal(value: typeof journal) {
      journal = value
    },
    journals,
    open,
    get root() {
      return root
    },
    set root(value: typeof root) {
      root = value
    },
    rows,
    seedWork,
    settle
  }
}
