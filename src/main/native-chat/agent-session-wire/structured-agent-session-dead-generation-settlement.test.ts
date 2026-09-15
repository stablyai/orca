import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openAgentSessionJournal } from '../agent-session-journal/journal-store-factory'
import type { AgentJournalRenderItem } from '../../../shared/agent-session-journal-types'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import {
  captureUnfinishedStructuredAgentSessionWork,
  MAX_UNEXPECTED_EXIT_REASON_CHARS,
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
  it('re-derives uncommitted chunks after an earlier lifecycle chunk committed', async () => {
    for (let ordinal = 1; ordinal <= 205; ordinal += 1) {
      await journal.appendItem(
        { provider: 'codex', threadId: THREAD, turnId: 'bulk', ordinal },
        { kind: 'tool-call', name: 'shell', input: {}, state: 'running' },
        { fence: 7 }
      )
    }
    const append = journal.appendLifecycleBatch.bind(journal)
    let calls = 0
    vi.spyOn(journal, 'appendLifecycleBatch').mockImplementation(async (input) => {
      calls += 1
      if (calls === 2) {
        throw new Error('second chunk unavailable')
      }
      return append(input)
    })
    const settle = () =>
      settleStructuredAgentSessionDeadGeneration({
        journal,
        sessionId: SESSION,
        fence: 8,
        throughFence: 7,
        settlementId: 'bulk-old-owner',
        pendingSubmissionReason: 'provider_exited_before_acknowledgement',
        verdict: { state: 'unverifiable' },
        showUnexpectedExitOutcome: false
      })

    expect(await settle()).toBe(false)
    expect(
      journal
        .snapshot()
        .items.some((item) => item.body.kind === 'tool-call' && item.body.state === 'running')
    ).toBe(true)
    expect(await settle()).toBe(true)
    expect(
      journal
        .snapshot()
        .items.filter((item) => item.body.kind === 'tool-call' && item.body.state === 'failed')
    ).toHaveLength(205)
  })

  it('re-derives only the dead owner after a replacement has published new work', async () => {
    await seedUnfinishedWork()
    await journal.appendSubmission({
      clientMessageId: 'client-new',
      payloadFingerprint: 'new-fingerprint',
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'new turn' }] },
      fence: 8
    })
    await journal.appendItem(
      { provider: 'codex', threadId: THREAD, turnId: 'turn-new', ordinal: 1 },
      { kind: 'turn', turnId: 'turn-new', state: 'running' },
      { fence: 8 }
    )
    await journal.appendItem(
      { provider: 'codex', threadId: THREAD, turnId: 'turn-new', ordinal: 2 },
      {
        kind: 'question',
        question: 'New owner?',
        options: [{ id: 'yes', label: 'Yes' }],
        resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
      },
      { fence: 8 }
    )

    expect(
      await settleStructuredAgentSessionDeadGeneration({
        journal,
        sessionId: SESSION,
        fence: 8,
        throughFence: 7,
        settlementId: 'old-owner',
        pendingSubmissionReason: 'provider_exited_before_acknowledgement',
        verdict: { state: 'interrupted', completedAt: 1_001 }
      })
    ).toBe(true)
    expect(journal.submissions()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ clientMessageId: 'client-1', dispatchState: 'unknown' }),
        expect.objectContaining({ clientMessageId: 'client-new', dispatchState: 'pending' })
      ])
    )
    expect(journal.snapshot().items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ownerFence: 7,
          body: expect.objectContaining({ state: 'interrupted' })
        }),
        expect.objectContaining({
          ownerFence: 8,
          body: expect.objectContaining({ state: 'running' })
        }),
        expect.objectContaining({
          ownerFence: 8,
          body: expect.objectContaining({
            resolution: expect.objectContaining({ state: 'pending' })
          })
        })
      ])
    )
  })

  it('leaves a replacement prompt pending when it is published after settlement', async () => {
    await seedUnfinishedWork()
    await settleStructuredAgentSessionDeadGeneration({
      journal,
      sessionId: SESSION,
      fence: 8,
      settlementId: 'acquire-before-bind',
      pendingSubmissionReason: 'provider_exited_before_acknowledgement',
      verdict: { state: 'unverifiable' },
      showUnexpectedExitOutcome: false
    })
    await journal.appendItem(
      { provider: 'codex', threadId: THREAD, turnId: 'replacement', ordinal: 1 },
      {
        kind: 'approval',
        title: 'Replacement approval',
        detail: null,
        options: [{ id: 'yes', label: 'Allow' }],
        resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
      },
      { fence: 8 }
    )
    expect(journal.snapshot().items.map((item) => item.body)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'approval',
          title: 'Run command?',
          resolution: expect.objectContaining({ state: 'cancelled' })
        }),
        expect.objectContaining({
          kind: 'approval',
          title: 'Replacement approval',
          resolution: expect.objectContaining({ state: 'pending' })
        })
      ])
    )
  })

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

  it('keeps the actionable tail when the provider dumps a stderr wall into its exit reason', async () => {
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
        unexpectedExitReason: 'stack frame '.repeat(4_000)
      })
    ).resolves.toBe(true)

    const statuses = journal
      .snapshot()
      .items.flatMap((item) => (item.body.kind === 'status' ? [item.body.text] : []))
    expect(statuses).toHaveLength(1)
    // The cause is bounded before composing, so the row never reaches the byte cap that would
    // truncate the sentence telling the user the conversation is still usable.
    expect(statuses[0]).toContain('stack frame')
    expect(statuses[0]).toMatch(/You can continue in this conversation\.$/)
    expect(statuses[0]?.length).toBeLessThan(MAX_UNEXPECTED_EXIT_REASON_CHARS * 2)
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
      'snapshot' | 'submissions' | 'markPendingSubmissionsUnknown' | 'appendLifecycleBatch'
    > = {
      snapshot: () => ({
        ...settledSnapshot,
        items: [settledItem]
      }),
      submissions: () => [],
      markPendingSubmissionsUnknown: async () => {
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
