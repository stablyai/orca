import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openAgentSessionJournal } from '../agent-session-journal/journal-store-factory'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { settleObservedExitForTest } from './structured-agent-session-observed-exit.test-fixture'
import {
  captureUnfinishedStructuredAgentSessionWork,
  unfinishedStructuredAgentSessionWorkWasInterrupted
} from './structured-agent-session-unfinished-work'
import {
  closeTestJournalHostDatabases,
  openTestJournalHostDatabase
} from '../agent-session-journal/journal-host-database-test-support'
import { codexProviderHandle } from '../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'

const SESSION = 'session-dead-generation'
const THREAD = 'thread-1'
let root: string
let journal: AgentSessionJournal

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-dead-generation-'))
  journal = await openAgentSessionJournal({
    identity: {
      sessionId: SESSION,
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: 'codex',
      providerHandle: codexProviderHandle(THREAD)
    },
    database: openTestJournalHostDatabase(root),
    now: () => 1_000
  })
})

afterEach(async () => {
  await journal.close()
  await closeTestJournalHostDatabases()
  await rm(root, { recursive: true, force: true })
})

async function seedUnfinishedWork(): Promise<void> {
  await journal.appendSubmission({
    clientMessageId: 'client-1',
    payloadFingerprint: 'fingerprint',
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'keep going' }] },
    fence: 7
  })
  await journal.appendItem(
    { provider: 'codex', threadId: THREAD, turnId: 'turn-1', ordinal: 1 },
    { kind: 'tool-call', name: 'shell', input: { command: 'pnpm test' }, state: 'running' },
    { fence: 7, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
  await journal.appendItem(
    { provider: 'codex', threadId: THREAD, turnId: 'turn-1', ordinal: 2 },
    {
      kind: 'approval',
      title: 'Run command?',
      detail: null,
      options: [{ id: 'yes', label: 'Allow' }],
      resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
    },
    { fence: 7, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
  await journal.appendItem(
    { provider: 'codex', threadId: THREAD, turnId: 'turn-1', ordinal: 3 },
    {
      kind: 'question',
      question: 'Which target?',
      options: [{ id: 'web', label: 'Web' }],
      resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
    },
    { fence: 7, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
  await journal.appendItem(
    { provider: 'codex', threadId: THREAD, turnId: 'turn-1', ordinal: 4 },
    { kind: 'turn', turnId: 'turn-1', state: 'running', startedAt: 900 },
    { fence: 7, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
}

describe('dead structured-session generation settlement', () => {
  it('settles probe-proven work as unverifiable without a technical chat row or fake end time', async () => {
    await seedUnfinishedWork()

    await expect(
      settleObservedExitForTest({
        journal,
        sessionId: SESSION,
        fence: 8,
        settlementId: `restart-eviction:${SESSION}:8`,
        pendingSubmissionReason: 'provider_exited_before_acknowledgement',
        verdict: { state: 'unverifiable' },
        showUnexpectedExitOutcome: false
      })
    ).resolves.toMatchObject({ ok: true })

    const snapshot = journal.snapshot()
    expect(snapshot.submissions).toEqual([
      expect.objectContaining({ clientMessageId: 'client-1', dispatchState: 'unknown' })
    ])
    expect(snapshot.items.map((item) => item.body)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'tool-call', state: 'failed' }),
        expect.objectContaining({
          kind: 'approval',
          resolution: expect.objectContaining({ state: 'cancelled' })
        }),
        expect.objectContaining({
          kind: 'question',
          resolution: expect.objectContaining({ state: 'cancelled' })
        }),
        { kind: 'turn', turnId: 'turn-1', state: 'unverifiable', startedAt: 900 }
      ])
    )
    expect(snapshot.items.some((item) => item.body.kind === 'status')).toBe(false)
    // Preserve unverifiable provenance for later correction by owner-specific exit proof.
    const tool = snapshot.items.find((item) => item.body.kind === 'tool-call')
    expect(tool?.body).toMatchObject({ state: 'failed', endedAs: 'unverifiable' })
  })

  it('settles a live unknown submission even when no unfinished item remains', async () => {
    await journal.appendSubmission({
      clientMessageId: 'client-unknown',
      payloadFingerprint: 'fingerprint',
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'did this land?' }] },
      fence: 7
    })
    await journal.resolveDispatch({
      clientMessageId: 'client-unknown',
      state: 'unknown',
      reason: 'provider write outcome unknown',
      fence: 7
    })

    await expect(
      settleObservedExitForTest({
        journal,
        sessionId: SESSION,
        fence: 7,
        settlementId: `expected-close:${SESSION}:7:generation-1`,
        pendingSubmissionReason: 'provider_closed_before_acknowledgement',
        verdict: { state: 'interrupted', completedAt: 1_000 },
        showUnexpectedExitOutcome: false
      })
    ).resolves.toMatchObject({ ok: true })

    expect(journal.submissions()).toEqual([
      expect.objectContaining({
        clientMessageId: 'client-unknown',
        dispatchState: 'unknown',
        recovered: true,
        reason: 'provider write outcome unknown'
      })
    ])
  })
})

describe('whether a dead generation interrupted anything', () => {
  async function seedIdlePendingApproval(): Promise<void> {
    await journal.appendItem(
      { provider: 'codex', threadId: THREAD, turnId: 'turn-1', ordinal: 1 },
      {
        kind: 'approval',
        title: 'Run command?',
        detail: null,
        options: [{ id: 'yes', label: 'Allow' }],
        resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
      },
      { fence: 7, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    await journal.appendItem(
      { provider: 'codex', threadId: THREAD, turnId: 'turn-1', ordinal: 2 },
      { kind: 'turn', turnId: 'turn-1', state: 'completed', startedAt: 900, completedAt: 950 },
      { fence: 7, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
  }

  it('says nothing was interrupted when the provider died waiting on an approval', async () => {
    await seedIdlePendingApproval()
    const before = captureUnfinishedStructuredAgentSessionWork(journal)

    expect(unfinishedStructuredAgentSessionWorkWasInterrupted(before, journal, 1_000)).toBe(false)
  })

  it('still reports an interruption when a turn was running', async () => {
    await seedUnfinishedWork()
    const before = captureUnfinishedStructuredAgentSessionWork(journal)

    expect(unfinishedStructuredAgentSessionWorkWasInterrupted(before, journal, 1_000)).toBe(true)
  })
})
