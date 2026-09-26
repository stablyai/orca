import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openAgentSessionJournal } from '../agent-session-journal/journal-store-factory'
import type { AgentJournalRenderItem } from '../../../shared/agent-session-journal-types'
import {
  agentSessionFailureFact,
  MAX_PROVIDER_DIAGNOSTIC_CHARS,
  providerDiagnostic
} from '../../../shared/agent-session-failure'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import {
  captureUnfinishedStructuredAgentSessionWork,
  settleStructuredAgentSessionDeadGeneration,
  UNEXPECTED_PROVIDER_EXIT_OUTCOME,
  unfinishedStructuredAgentSessionWorkWasInterrupted
} from './structured-agent-session-dead-generation-settlement'

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
      providerHandle: { kind: 'codex', threadId: THREAD }
    },
    journalDir: root,
    now: () => 1_000
  })
})

afterEach(async () => {
  await journal.close()
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
    { fence: 7 }
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
    { fence: 7 }
  )
  await journal.appendItem(
    { provider: 'codex', threadId: THREAD, turnId: 'turn-1', ordinal: 3 },
    {
      kind: 'question',
      question: 'Which target?',
      options: [{ id: 'web', label: 'Web' }],
      resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
    },
    { fence: 7 }
  )
  await journal.appendItem(
    { provider: 'codex', threadId: THREAD, turnId: 'turn-1', ordinal: 4 },
    { kind: 'turn', turnId: 'turn-1', state: 'running', startedAt: 900 },
    { fence: 7 }
  )
}

describe('dead structured-session generation settlement', () => {
  it('settles probe-proven work as unverifiable without a technical chat row or fake end time', async () => {
    await seedUnfinishedWork()

    await expect(
      settleStructuredAgentSessionDeadGeneration({
        journal,
        sessionId: SESSION,
        fence: 8,
        settlementId: `restart-eviction:${SESSION}:8`,
        pendingSubmissionReason: 'provider_exited_before_acknowledgement',
        verdict: { state: 'unverifiable' },
        showUnexpectedExitOutcome: false
      })
    ).resolves.toBe(true)

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
  })

  it('adds one actionable outcome for observed active-work failure and is idempotent', async () => {
    await seedUnfinishedWork()
    const input = {
      journal,
      sessionId: SESSION,
      fence: 7,
      settlementId: `provider-exit:${SESSION}:7:generation-1`,
      pendingSubmissionReason: 'provider_exited_before_acknowledgement',
      verdict: { state: 'interrupted' as const, completedAt: 1_000 },
      showUnexpectedExitOutcome: true
    }

    await expect(settleStructuredAgentSessionDeadGeneration(input)).resolves.toBe(true)
    const settledCursor = journal.cursor()
    await expect(settleStructuredAgentSessionDeadGeneration(input)).resolves.toBe(true)

    expect(journal.cursor()).toEqual(settledCursor)
    expect(
      journal
        .snapshot()
        .items.filter(
          (item) =>
            item.body.kind === 'status' && item.body.text === UNEXPECTED_PROVIDER_EXIT_OUTCOME
        )
    ).toHaveLength(1)
  })

  it('keeps a stderr wall out of the sentence, as a bounded detail for a log', async () => {
    await seedUnfinishedWork()

    await expect(
      settleStructuredAgentSessionDeadGeneration({
        journal,
        sessionId: SESSION,
        fence: 7,
        settlementId: `provider-exit:${SESSION}:7:generation-1`,
        pendingSubmissionReason: 'provider_exited_before_acknowledgement',
        verdict: { state: 'interrupted', completedAt: 1_000 },
        showUnexpectedExitOutcome: true,
        exitFailure: agentSessionFailureFact('providerExited', {
          detail: providerDiagnostic('stack frame '.repeat(4_000), 'log')
        })
      })
    ).resolves.toBe(true)

    const statuses = journal
      .snapshot()
      .items.flatMap((item) => (item.body.kind === 'status' ? [item.body] : []))
    expect(statuses).toHaveLength(1)
    expect(statuses[0]?.text).toBe(UNEXPECTED_PROVIDER_EXIT_OUTCOME)
    expect(statuses[0]?.failure?.kind).toBe('providerExited')
    expect(statuses[0]?.failure?.detail?.audience).toBe('log')
    expect(statuses[0]?.failure?.detail?.text.length).toBe(MAX_PROVIDER_DIAGNOSTIC_CHARS)
  })

  it('retries an already settled expected close without writing through a closed journal gate', async () => {
    const settledItem: AgentJournalRenderItem = {
      itemId: 'codex:thread-1:turn-1:0',
      revision: 2,
      sequence: 2,
      observedAt: 1_000,
      body: {
        kind: 'turn',
        turnId: 'turn-1',
        state: 'interrupted',
        completedAt: 1_000
      }
    }
    const settledSnapshot = journal.snapshot()
    const closedJournal: Pick<
      AgentSessionJournal,
      | 'snapshot'
      | 'submissions'
      | 'markPendingSubmissionsUnknown'
      | 'rejectPendingSubmissions'
      | 'rejectQueuedSubmissions'
      | 'appendLifecycleBatch'
    > = {
      snapshot: () => ({
        ...settledSnapshot,
        items: [settledItem]
      }),
      submissions: () => [],
      markPendingSubmissionsUnknown: async () => {
        throw new Error('journal_closed')
      },
      rejectPendingSubmissions: async () => {
        throw new Error('journal_closed')
      },
      rejectQueuedSubmissions: async () => {
        throw new Error('journal_closed')
      },
      appendLifecycleBatch: async () => {
        throw new Error('journal_closed')
      }
    }

    await expect(
      settleStructuredAgentSessionDeadGeneration({
        journal: closedJournal,
        sessionId: SESSION,
        fence: 7,
        settlementId: `expected-close:${SESSION}:7:generation-1`,
        pendingSubmissionReason: 'provider_closed_before_acknowledgement',
        verdict: { state: 'interrupted', completedAt: 1_000 },
        showUnexpectedExitOutcome: false
      })
    ).resolves.toBe(true)
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
      settleStructuredAgentSessionDeadGeneration({
        journal,
        sessionId: SESSION,
        fence: 7,
        settlementId: `expected-close:${SESSION}:7:generation-1`,
        pendingSubmissionReason: 'provider_closed_before_acknowledgement',
        verdict: { state: 'interrupted', completedAt: 1_000 },
        showUnexpectedExitOutcome: false
      })
    ).resolves.toBe(true)

    expect(journal.submissions()).toEqual([
      expect.objectContaining({
        clientMessageId: 'client-unknown',
        dispatchState: 'unknown',
        recovered: true,
        reason: 'provider write outcome unknown'
      })
    ])
  })

  it('rejects a send a child that never started left pending with its diagnostic, in words', async () => {
    await journal.appendSubmission({
      clientMessageId: 'client-held',
      payloadFingerprint: 'fingerprint',
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hello?' }] },
      fence: 7
    })

    await settleStructuredAgentSessionDeadGeneration({
      journal,
      sessionId: SESSION,
      fence: 7,
      settlementId: `provider-exit:${SESSION}:7:generation-1`,
      pendingSubmissionReason: 'provider_closed_before_acknowledgement',
      verdict: { state: 'interrupted', completedAt: 1_000 },
      exitFailure: agentSessionFailureFact('providerExited', {
        detail: providerDiagnostic('code 1\nnot signed in', 'log')
      }),
      exitedDuringStartup: { generation: 'generation-1' }
    })

    // The sentence is Orca's; the stderr the exit carried rides as a log detail only.
    expect(journal.submissions()).toEqual([
      expect.objectContaining({
        clientMessageId: 'client-held',
        dispatchState: 'rejected',
        reason: 'The provider stopped before it finished starting.',
        rejection: {
          kind: 'providerStartFailed',
          detail: { text: 'code 1\nnot signed in', audience: 'log' }
        }
      })
    ])
  })

  it("keeps a subagent's settled rows the subagent's, in one batch and after a reopen", async () => {
    // One batch settles rows several agents wrote and names none of them. Each
    // row keeps the producer its first write named, including after a replay.
    const child = { agentId: 'thread-child', producerKind: 'agent' as const }
    const childCall = {
      provider: 'codex' as const,
      threadId: 'thread-child',
      turnId: 'c',
      ordinal: 1
    }
    const childAsk = {
      provider: 'codex' as const,
      threadId: 'thread-child',
      turnId: 'c',
      ordinal: 2
    }
    await seedUnfinishedWork()
    await journal.appendItem(
      childCall,
      { kind: 'tool-call', name: 'shell', input: { command: 'ls' }, state: 'running' },
      { fence: 7, ...child }
    )
    await journal.appendItem(
      childAsk,
      {
        kind: 'approval',
        title: 'Run ls?',
        detail: null,
        options: [{ id: 'yes', label: 'Allow' }],
        resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
      },
      { fence: 7, ...child }
    )

    await settleStructuredAgentSessionDeadGeneration({
      journal,
      sessionId: SESSION,
      fence: 8,
      settlementId: `restart-eviction:${SESSION}:8`,
      pendingSubmissionReason: 'provider_exited_before_acknowledgement',
      verdict: { state: 'unverifiable' },
      showUnexpectedExitOutcome: false
    })
    const settledProducers = (): [string, number, string | undefined][] =>
      journal
        .snapshot()
        .items.map((item): [string, number, string | undefined] => [
          item.body.kind,
          item.revision,
          item.agentId
        ])

    const settled = settledProducers()
    // Every seeded row was revised by the batch, so these are revision-2 producers.
    expect(settled).toEqual([
      ['message', 0, undefined],
      ['tool-call', 2, undefined],
      ['approval', 2, undefined],
      ['question', 2, undefined],
      ['turn', 2, undefined],
      ['tool-call', 2, 'thread-child'],
      ['approval', 2, 'thread-child']
    ])

    await journal.close()
    journal = await openAgentSessionJournal({
      identity: {
        sessionId: SESSION,
        workspaceId: 'workspace-1',
        hostId: 'local',
        agent: 'codex',
        providerHandle: { kind: 'codex', threadId: THREAD }
      },
      journalDir: root,
      now: () => 1_000
    })
    expect(settledProducers()).toEqual(settled)
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
      { fence: 7 }
    )
    await journal.appendItem(
      { provider: 'codex', threadId: THREAD, turnId: 'turn-1', ordinal: 2 },
      { kind: 'turn', turnId: 'turn-1', state: 'completed', startedAt: 900, completedAt: 950 },
      { fence: 7 }
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

  it('cancels the idle prompt without claiming a response was in progress', async () => {
    await seedIdlePendingApproval()

    await expect(
      settleStructuredAgentSessionDeadGeneration({
        journal,
        sessionId: SESSION,
        fence: 7,
        settlementId: `provider-exit:${SESSION}:7:generation-1`,
        pendingSubmissionReason: 'provider_exited_before_acknowledgement',
        verdict: { state: 'interrupted', completedAt: 1_000 },
        showUnexpectedExitOutcome: unfinishedStructuredAgentSessionWorkWasInterrupted(
          captureUnfinishedStructuredAgentSessionWork(journal),
          journal,
          1_000
        )
      })
    ).resolves.toBe(true)

    const snapshot = journal.snapshot()
    expect(snapshot.items.some((item) => item.body.kind === 'status')).toBe(false)
    expect(snapshot.items.map((item) => item.body)).toContainEqual(
      expect.objectContaining({
        kind: 'approval',
        resolution: expect.objectContaining({ state: 'cancelled' })
      })
    )
  })
})
