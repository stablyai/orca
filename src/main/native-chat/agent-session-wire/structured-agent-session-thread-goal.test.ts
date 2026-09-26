import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentJournalThreadGoal,
  AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { createTrackedJournalOpener } from '../agent-session-journal/journal-store-test-open'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import {
  journalRecordsThreadGoalChange,
  performThreadGoalChange,
  threadGoalPlan
} from './structured-agent-session-thread-goal'
import type { AgentSessionTurnContext } from './structured-agent-session-turns'

const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: 'session-1',
  workspaceId: 'workspace-1',
  hostId: 'host-1',
  agent: 'codex',
  providerHandle: { kind: 'codex', threadId: 'thread-1' }
}

let root: string | null = null
const journals = createTrackedJournalOpener()

afterEach(async () => {
  await journals.closeAll()
  if (root) {
    await rm(root, { recursive: true, force: true })
    root = null
  }
})

async function openJournal(): Promise<AgentSessionJournal> {
  root ??= await mkdtemp(join(tmpdir(), 'orca-thread-goal-'))
  return journals.open({ identity: IDENTITY, journalDir: root })
}

const GOAL: AgentJournalThreadGoal = {
  objective: 'Ship the parser',
  status: 'active',
  tokenBudget: null,
  tokensUsed: 1,
  timeUsedSeconds: 2,
  createdAt: 3_000,
  updatedAt: 4_000
}

function appendGoalRow(
  journal: AgentSessionJournal,
  overrides: Partial<AgentJournalThreadGoal>
): Promise<unknown> {
  return journal.appendItem(
    { provider: 'orca', clientMessageId: `goal-row:${journal.snapshot().items.length}` },
    { kind: 'status', text: 'Goal', threadGoal: { state: 'set', goal: { ...GOAL, ...overrides } } },
    { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
}

function context(
  journal: AgentSessionJournal,
  adapter: Partial<StructuredAgentSessionAdapter>,
  flushStreamedEvents: () => Promise<void> = async () => undefined
): AgentSessionTurnContext {
  return {
    sessionId: 'session-1',
    journal,
    fence: 1,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the goal path reads only the goal methods.
    adapter: adapter as StructuredAgentSessionAdapter,
    persistOptions: async () => undefined,
    resolvedBy: 'client-1',
    publish: vi.fn(),
    flushStreamedEvents,
    now: () => 1
  }
}

describe('performThreadGoalChange', () => {
  it('journals the objective as a user message sent as a goal, durably', async () => {
    const journal = await openJournal()
    const changeThreadGoal = vi.fn(async () => ({ ok: true as const }))

    const result = await performThreadGoalChange(
      context(journal, { changeThreadGoal, supportsThreadGoal: () => true }),
      { clientOperationId: 'op-1', change: { kind: 'set', objective: 'Ship the parser' } }
    )

    expect(result).toEqual({ ok: true, value: { change: 'set' } })
    expect(changeThreadGoal).toHaveBeenCalledWith({
      sessionId: 'session-1',
      fence: 1,
      change: { kind: 'set', objective: 'Ship the parser' },
      replacesGoal: false
    })
    const expected = {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: 'Ship the parser' }],
      sentAs: 'goal'
    }
    expect(journal.snapshot().items.map((item) => item.body)).toEqual([expected])

    // The marker must survive a reopen: the persisted row validator admits it.
    await journal.close()
    const reopened = await openJournal()
    expect(reopened.snapshot().items.map((item) => item.body)).toEqual([expected])
  })

  it('removes the objective when the provider refuses the goal', async () => {
    const journal = await openJournal()
    const ctx = context(journal, {
      changeThreadGoal: async () => ({ ok: false, rejected: 'goals feature is disabled' }),
      supportsThreadGoal: () => true
    })

    const result = await performThreadGoalChange(ctx, {
      clientOperationId: 'op-2',
      change: { kind: 'set', objective: 'Ship the parser' }
    })

    expect(result).toEqual({
      ok: false,
      refusal: { code: 'agent_session_operation_invalid', message: 'goals feature is disabled' }
    })
    expect(journal.snapshot().items).toEqual([])
  })

  it('removes the objective when the provider request fails outright', async () => {
    const journal = await openJournal()
    const ctx = context(journal, {
      changeThreadGoal: async () => {
        throw new Error('connection closed')
      },
      supportsThreadGoal: () => true
    })

    await expect(
      performThreadGoalChange(ctx, {
        clientOperationId: 'op-3',
        change: { kind: 'set', objective: 'Ship the parser' }
      })
    ).rejects.toThrow('connection closed')
    expect(journal.snapshot().items).toEqual([])
  })

  it('puts the objective back, once, when a withdrawn set runs again', async () => {
    const journal = await openJournal()
    const attempts: (() => Promise<{ ok: true }>)[] = [
      async () => {
        throw new Error('request timed out')
      },
      async () => ({ ok: true as const })
    ]
    const ctx = context(journal, {
      changeThreadGoal: () => attempts.shift()!(),
      supportsThreadGoal: () => true
    })
    const input = {
      clientOperationId: 'op-9',
      change: { kind: 'set' as const, objective: 'Ship the parser' }
    }

    await expect(performThreadGoalChange(ctx, input)).rejects.toThrow('request timed out')
    expect(journal.snapshot().items).toEqual([])

    // The ledger reruns the same operation id; its tombstoned row revives, not doubles.
    await expect(performThreadGoalChange(ctx, input)).resolves.toEqual({
      ok: true,
      value: { change: 'set' }
    })
    expect(journal.snapshot().items.map((item) => item.body)).toEqual([
      {
        kind: 'message',
        role: 'user',
        blocks: [{ type: 'text', text: 'Ship the parser' }],
        sentAs: 'goal'
      }
    ])
  })

  it('journals nothing for a status change or clear', async () => {
    const journal = await openJournal()
    const changeThreadGoal = vi.fn(async () => ({ ok: true as const }))
    const ctx = context(journal, { changeThreadGoal, supportsThreadGoal: () => true })

    await performThreadGoalChange(ctx, {
      clientOperationId: 'op-3',
      change: { kind: 'status', status: 'paused' }
    })
    await performThreadGoalChange(ctx, { clientOperationId: 'op-4', change: { kind: 'clear' } })

    expect(changeThreadGoal).toHaveBeenCalledTimes(2)
    expect(journal.snapshot().items).toEqual([])
  })

  it('refuses a session whose provider has no goals, without touching the journal', async () => {
    const journal = await openJournal()
    const changeThreadGoal = vi.fn(async () => ({ ok: true as const }))

    const result = await performThreadGoalChange(
      context(journal, { changeThreadGoal, supportsThreadGoal: () => false }),
      { clientOperationId: 'op-5', change: { kind: 'set', objective: 'Ship it' } }
    )

    expect(result).toMatchObject({
      ok: false,
      refusal: { code: 'agent_session_operation_invalid' }
    })
    expect(changeThreadGoal).not.toHaveBeenCalled()
    expect(journal.snapshot().items).toEqual([])
  })

  it('reports the latest goal the whole journal records', async () => {
    const journal = await openJournal()
    expect(journal.threadGoal()).toBeNull()
    await appendGoalRow(journal, { status: 'paused' })
    expect(journal.threadGoal()).toEqual({ ...GOAL, status: 'paused' })
  })

  it('tells the adapter a set replaces the goal the journal records, whatever its status', async () => {
    const journal = await openJournal()
    await appendGoalRow(journal, { status: 'complete' })
    const changeThreadGoal = vi.fn(async () => ({ ok: true as const }))
    const ctx = context(journal, { changeThreadGoal, supportsThreadGoal: () => true })

    await performThreadGoalChange(ctx, {
      clientOperationId: 'op-6',
      change: { kind: 'set', objective: 'Ship the tests' }
    })
    await performThreadGoalChange(ctx, {
      clientOperationId: 'op-7',
      change: { kind: 'status', status: 'paused' }
    })

    expect(changeThreadGoal.mock.calls).toEqual([
      [
        expect.objectContaining({
          change: { kind: 'set', objective: 'Ship the tests' },
          replacesGoal: true
        })
      ],
      [
        expect.objectContaining({
          change: { kind: 'status', status: 'paused' },
          replacesGoal: false
        })
      ]
    ])
  })

  it('drains accepted provider events before deciding whether a set replaces a goal', async () => {
    const journal = await openJournal()
    const changeThreadGoal = vi.fn(async () => ({ ok: true as const }))
    // The goal the provider reported is still in the deferred sink when the set arrives.
    const ctx = context(journal, { changeThreadGoal, supportsThreadGoal: () => true }, async () => {
      await appendGoalRow(journal, { status: 'active' })
    })

    await performThreadGoalChange(ctx, {
      clientOperationId: 'op-10',
      change: { kind: 'set', objective: 'Ship the tests' }
    })

    expect(changeThreadGoal).toHaveBeenCalledWith(expect.objectContaining({ replacesGoal: true }))
  })
})

describe('threadGoalPlan replay', () => {
  const envelope = {
    sessionId: 'session-1',
    clientOperationId: 'op-8',
    expectedRuntimeFence: 1,
    payloadFingerprint: 'fp'
  }

  it('answers a lost response from the goal the journal records, and runs again otherwise', async () => {
    const journal = await openJournal()
    const ctx = context(journal, {})
    const paused = threadGoalPlan({ envelope, change: { kind: 'status', status: 'paused' } })
    const set = threadGoalPlan({ envelope, change: { kind: 'set', objective: 'Ship the parser' } })
    const clear = threadGoalPlan({ envelope, change: { kind: 'clear' } })
    const unknown = { status: 'unknown' as const }

    expect(paused.recoverUnknownFromDurableState).toBe(true)
    expect(paused.rerunWhenReplayMissing?.(ctx)).toBe(true)
    // Nothing recorded yet: only a clear reads as applied.
    expect(paused.replay(ctx, unknown)).toBeNull()
    expect(set.replay(ctx, unknown)).toBeNull()
    expect(clear.replay(ctx, unknown)).toEqual({ change: 'clear' })

    await appendGoalRow(journal, { status: 'paused' })
    expect(paused.replay(ctx, unknown)).toEqual({ change: 'status' })
    expect(set.replay(ctx, unknown)).toBeNull()
    expect(clear.replay(ctx, unknown)).toBeNull()

    // A settled success always replays; a refusal never does.
    expect(set.replay(ctx, { status: 'succeeded', sessionId: 'session-1' })).toEqual({
      change: 'set'
    })
    expect(
      set.replay(ctx, { status: 'failed', code: 'agent_session_operation_invalid' })
    ).toBeNull()
  })

  it('reads a set as applied only when the recorded goal is that objective, active', () => {
    const change = { kind: 'set' as const, objective: 'Ship the parser' }
    expect(journalRecordsThreadGoalChange(GOAL, change)).toBe(true)
    expect(journalRecordsThreadGoalChange({ ...GOAL, status: 'paused' }, change)).toBe(false)
    expect(journalRecordsThreadGoalChange({ ...GOAL, objective: 'Ship it' }, change)).toBe(false)
    expect(journalRecordsThreadGoalChange(null, change)).toBe(false)
  })

  it('reads a status change as applied only when the recorded goal is in that status', () => {
    const pause = { kind: 'status' as const, status: 'paused' as const }
    expect(journalRecordsThreadGoalChange({ ...GOAL, status: 'paused' }, pause)).toBe(true)
    expect(journalRecordsThreadGoalChange(GOAL, pause)).toBe(false)
    expect(
      journalRecordsThreadGoalChange(
        { ...GOAL, status: 'paused' },
        { kind: 'status', status: 'active' }
      )
    ).toBe(false)
    expect(journalRecordsThreadGoalChange(null, pause)).toBe(false)
  })
})
