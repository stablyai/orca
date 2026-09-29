import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import type { AgentJournalRenderItem } from '../../../shared/agent-session-journal-types'
import type { AgentSessionDeathEvidence } from '../../../shared/agent-session-record'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { createTrackedJournalOpener } from '../agent-session-journal/journal-store-test-open'
import { settleStaleStructuredAgentSessionState } from './structured-agent-session-dead-generation-settlement'
import {
  runningTurnLifecycleRevisions,
  turnVerdictFromDeathEvidence,
  UNVERIFIABLE_TURN_VERDICT
} from './structured-agent-session-stale-turn-verdict'

const THREAD = 'thread-1'
const RUNNING_IDENTITY = {
  provider: 'codex' as const,
  threadId: THREAD,
  turnId: 'turn-2',
  ordinal: 0
}

function lifecycleItem(
  turnId: string,
  state: 'running' | 'completed',
  sequence: number,
  extra: { startedAt?: number; completedAt?: number } = {}
): AgentJournalRenderItem {
  return {
    itemId: agentJournalItemKey({ provider: 'codex', threadId: THREAD, turnId, ordinal: 0 }),
    revision: 1,
    sequence,
    observedAt: sequence,
    body: { kind: 'turn', turnId, state, ...extra }
  }
}

/** The status-form carrier an older host wrote; still read, never written back. */
function legacyLifecycleItem(turnId: string, startedAt: number): AgentJournalRenderItem {
  return {
    ...lifecycleItem(turnId, 'running', 2),
    body: {
      kind: 'status',
      text: 'Working',
      turnLifecycle: { turnId, state: 'running', startedAt }
    }
  }
}

function promptItem(state: 'pending' | 'resolved', sequence: number): AgentJournalRenderItem {
  return {
    itemId: agentJournalItemKey({
      provider: 'legacy',
      agent: 'codex',
      sessionId: 'session-1',
      recordId: `approval-${state}`
    }),
    revision: 1,
    sequence,
    observedAt: sequence,
    body: {
      kind: 'approval',
      title: 'Approve?',
      detail: null,
      options: [],
      resolution: {
        state,
        selectedOptionId: state === 'resolved' ? 'allow' : null,
        resolvedBy: state === 'resolved' ? 'client-1' : null,
        resolvedAt: state === 'resolved' ? 10 : null
      }
    }
  }
}

describe('turn verdict from death evidence', () => {
  /** Judges a turn the fence-1 owner wrote, by evidence naming that owner. */
  const verdictForTurn = (evidence: AgentSessionDeathEvidence | null | undefined) =>
    turnVerdictFromDeathEvidence(evidence && { ownerFence: 1, ...evidence }, 1)

  it('ends a watched exit at the exit', () => {
    expect(verdictForTurn({ kind: 'exit-observed', detail: 'exit', observedAt: 500 })).toEqual({
      state: 'interrupted',
      completedAt: 500
    })
  })

  it.each(['pid-absent', 'identity-mismatch'] as const)(
    'ends a %s proof at the last proof of life, never after the probe',
    (kind) => {
      const proof = (lastProvenAliveAt?: number) => ({
        kind,
        detail: 'gone',
        observedAt: 9_000,
        ...(lastProvenAliveAt === undefined ? {} : { lastProvenAliveAt })
      })
      // Probed at 9000, long after the crash: the downtime is never counted as work.
      expect(verdictForTurn(proof(8_000))).toEqual({ state: 'interrupted', completedAt: 8_000 })
      expect(verdictForTurn(proof(9_500))).toEqual({ state: 'interrupted', completedAt: 9_000 })
      // A proof that recorded no proof of life has only the probe.
      expect(verdictForTurn(proof())).toEqual({ state: 'interrupted', completedAt: 9_000 })
    }
  )

  it('ends a watched exit at the exit even when a renewal is recorded', () => {
    expect(
      verdictForTurn({
        kind: 'exit-observed',
        detail: 'exit',
        observedAt: 500,
        lastProvenAliveAt: 400
      })
    ).toEqual({ state: 'interrupted', completedAt: 500 })
  })

  it('leaves a release nothing proved unverifiable', () => {
    expect(verdictForTurn(null)).toEqual({ state: 'unverifiable' })
    expect(verdictForTurn(undefined)).toEqual({ state: 'unverifiable' })
  })
  it('keeps the rule an older build applied to evidence that names no owner', () => {
    // Only a watched exit was proof then; a probe's proof stays unverifiable.
    const legacy = { detail: 'gone', observedAt: 9_000, lastProvenAliveAt: 8_000 }
    expect(turnVerdictFromDeathEvidence({ ...legacy, kind: 'exit-observed' }, 1)).toEqual({
      state: 'interrupted',
      completedAt: 9_000
    })
    expect(turnVerdictFromDeathEvidence({ ...legacy, kind: 'pid-absent' }, 1)).toEqual({
      state: 'unverifiable'
    })
  })

  it('gives a turn no end from evidence about any other owner', () => {
    const proof = {
      kind: 'pid-absent' as const,
      detail: 'gone',
      observedAt: 9_000,
      lastProvenAliveAt: 8_000
    }
    // A newer start's death, and a turn whose writer the timeline no longer knows: neither proves
    // the turn's own owner gone.
    for (const [evidence, turnFence] of [
      [{ ...proof, ownerFence: 3 }, 1],
      [{ ...proof, kind: 'exit-observed' as const, ownerFence: 3 }, 1],
      [{ ...proof, ownerFence: 1 }, undefined]
    ] as const) {
      expect(turnVerdictFromDeathEvidence(evidence, turnFence)).toEqual({ state: 'unverifiable' })
    }
  })
})

describe('running turn lifecycle revisions', () => {
  it('revises only running rows in place and carries an end time only for an observed exit', () => {
    const items = [
      lifecycleItem('turn-1', 'completed', 1, { startedAt: 10, completedAt: 20 }),
      // A stray end on a running row is never carried into the verdict.
      lifecycleItem('turn-2', 'running', 2, { startedAt: 30, completedAt: 99 })
    ]
    expect(runningTurnLifecycleRevisions(items, { state: 'interrupted', completedAt: 40 })).toEqual(
      [
        {
          kind: 'item',
          identity: RUNNING_IDENTITY,
          body: {
            kind: 'turn',
            turnId: 'turn-2',
            state: 'interrupted',
            startedAt: 30,
            completedAt: 40
          }
        }
      ]
    )
    expect(runningTurnLifecycleRevisions(items, { state: 'unverifiable' })).toEqual([
      expect.objectContaining({
        body: { kind: 'turn', turnId: 'turn-2', state: 'unverifiable', startedAt: 30 }
      })
    ])
  })

  it('keeps every field it does not own when the host settles a running row', () => {
    const contextUsage = {
      used: {
        kind: 'estimate' as const,
        usage: {
          inputTokens: 1,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 90_000,
          outputTokens: 5
        },
        capturedAt: 35
      }
    }
    const running = lifecycleItem('turn-2', 'running', 2, { startedAt: 30 })
    const body = {
      ...running.body,
      requestedAt: 29,
      userItemId: 'user-2',
      contextUsage,
      // A field a newer build wrote: the verdict does not own it, so it survives.
      laterField: { kept: true },
      outcome: 'success' as const,
      durationMs: 7
    }
    const items: AgentJournalRenderItem[] = [{ ...running, body }]
    const kept = {
      kind: 'turn',
      turnId: 'turn-2',
      startedAt: 30,
      requestedAt: 29,
      userItemId: 'user-2',
      contextUsage,
      laterField: { kept: true }
    }
    expect(
      runningTurnLifecycleRevisions(items, { state: 'interrupted', completedAt: 40 })[0]
    ).toMatchObject({ body: { ...kept, state: 'interrupted', completedAt: 40 } })
    const unverifiable = runningTurnLifecycleRevisions(items, UNVERIFIABLE_TURN_VERDICT)[0]
    expect(unverifiable?.kind === 'item' ? unverifiable.body : null).toEqual({
      ...kept,
      state: 'unverifiable'
    })
  })

  it('never ends a turn before it began, when the last proof of life predates it', () => {
    const item = lifecycleItem('turn-2', 'running', 2, { startedAt: 500 })
    expect(
      runningTurnLifecycleRevisions([item], { state: 'interrupted', completedAt: 300 })
    ).toMatchObject([{ body: { kind: 'turn', state: 'interrupted', completedAt: 500 } }])
  })

  it('revises a legacy status-form running row from an older host into a typed turn', () => {
    expect(
      runningTurnLifecycleRevisions([legacyLifecycleItem('turn-2', 30)], { state: 'unverifiable' })
    ).toEqual([
      {
        kind: 'item',
        identity: RUNNING_IDENTITY,
        body: { kind: 'turn', turnId: 'turn-2', state: 'unverifiable', startedAt: 30 }
      }
    ])
  })

  it('skips rows without a parseable identity', () => {
    const item = { ...lifecycleItem('turn-2', 'running', 2), itemId: 'not-an-item-key' }
    expect(runningTurnLifecycleRevisions([item], { state: 'unverifiable' })).toEqual([])
  })
})

/** A probe that found the fence-1 owner gone at 9000, last proven alive at 100. */
const PROVEN: AgentSessionDeathEvidence = {
  kind: 'pid-absent',
  detail: 'recorded pid absent on host',
  observedAt: 9_000,
  ownerFence: 1,
  lastProvenAliveAt: 100
}

describe('stale session state on a cold acquire', () => {
  function journalWith(items: AgentJournalRenderItem[]) {
    const appendLifecycleBatch = vi.fn(
      async (_batch: { mutations: readonly { kind: string; body?: { kind: string } }[] }) => ({
        epoch: 'epoch-1',
        sequence: 9
      })
    )
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the settle reads only these journal members.
    const journal = {
      snapshot: () => ({ items }),
      itemFence: () => 1,
      cursor: () => ({ epoch: 'epoch-1', sequence: 8 }),
      appendLifecycleBatch
    } as unknown as AgentSessionJournal
    return { journal, appendLifecycleBatch }
  }

  it('marks a running row from the dead generation unverifiable without an end time', async () => {
    const { journal, appendLifecycleBatch } = journalWith([
      lifecycleItem('turn-1', 'completed', 1, { startedAt: 10, completedAt: 20 }),
      lifecycleItem('turn-2', 'running', 2, { startedAt: 30 })
    ])

    await expect(
      settleStaleStructuredAgentSessionState({
        journal,
        sessionId: 'session-1',
        fence: 14,
        acquisitionGeneration: 'generation-2',
        deathEvidence: null
      })
    ).resolves.toBe(1)

    expect(appendLifecycleBatch).toHaveBeenCalledExactlyOnceWith({
      settlementId: 'stale-session:session-1:14:generation-2',
      fence: 14,
      recovered: true,
      mutations: [
        {
          kind: 'item',
          identity: RUNNING_IDENTITY,
          body: { kind: 'turn', turnId: 'turn-2', state: 'unverifiable', startedAt: 30 }
        }
      ]
    })
  })

  it('cancels only prompts whose callbacks were lost with the prior owner', async () => {
    const pending = promptItem('pending', 1)
    const resolved = promptItem('resolved', 2)
    const { journal, appendLifecycleBatch } = journalWith([pending, resolved])

    await expect(
      settleStaleStructuredAgentSessionState({
        journal,
        sessionId: 'session-1',
        fence: 14,
        acquisitionGeneration: 'generation-2',
        deathEvidence: null
      })
    ).resolves.toBe(1)

    expect(appendLifecycleBatch).toHaveBeenCalledExactlyOnceWith({
      settlementId: 'stale-session:session-1:14:generation-2',
      fence: 14,
      recovered: true,
      mutations: [
        {
          kind: 'item',
          identity: {
            provider: 'legacy',
            agent: 'codex',
            sessionId: 'session-1',
            recordId: 'approval-pending'
          },
          body: {
            ...pending.body,
            resolution: {
              state: 'cancelled',
              selectedOptionId: null,
              resolvedBy: null,
              resolvedAt: null
            }
          }
        }
      ]
    })
  })

  it("cancels a subagent's lost prompt as the subagent's, and the session's own as its own", async () => {
    // The sweep names no producer, so each cancelled row keeps the one it had.
    const root = await mkdtemp(join(tmpdir(), 'orca-stale-session-'))
    const journals = createTrackedJournalOpener()
    try {
      const journal = await journals.open({
        identity: {
          sessionId: 'session-1',
          workspaceId: 'workspace-1',
          hostId: 'local',
          agent: 'codex',
          providerHandle: { kind: 'codex', threadId: THREAD }
        },
        journalDir: root,
        now: () => 1_000
      })
      const child = { agentId: 'thread-child', producerKind: 'agent' as const }
      const { body } = promptItem('pending', 1)
      const prompt = (threadId: string) => ({
        provider: 'codex' as const,
        threadId,
        turnId: 'turn-1',
        ordinal: 1
      })
      await journal.appendItem(prompt('thread-child'), body, { fence: 1, ...child })
      await journal.appendItem(prompt(THREAD), body, { fence: 1 })

      await settleStaleStructuredAgentSessionState({
        journal,
        sessionId: 'session-1',
        fence: 2,
        acquisitionGeneration: 'generation-2',
        deathEvidence: null
      })

      expect(
        journal.snapshot().items.map((item) => [item.body.kind, item.revision, item.agentId])
      ).toEqual([
        ['approval', 2, 'thread-child'],
        ['approval', 2, undefined]
      ])
    } finally {
      await journals.closeAll()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('ends a probe-proven turn at its last proof of life, not at a row written after it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-stale-session-'))
    const journals = createTrackedJournalOpener()
    let now = 100
    try {
      const journal = await journals.open({
        identity: {
          sessionId: 'session-1',
          workspaceId: 'workspace-1',
          hostId: 'local',
          agent: 'codex',
          providerHandle: { kind: 'codex', threadId: THREAD }
        },
        journalDir: root,
        now: () => now
      })
      const command = { provider: 'codex' as const, threadId: THREAD, turnId: 'turn-1', ordinal: 1 }
      const shell = { kind: 'tool-call' as const, name: 'shell', input: { command: 'pnpm test' } }
      await journal.appendItem(
        { ...command, ordinal: 0 },
        { kind: 'turn', turnId: 'turn-1', state: 'running', startedAt: 100 },
        { fence: 1 }
      )
      now = 200
      await journal.appendItem(command, { ...shell, state: 'running' }, { fence: 1 })
      // Rows can outlast the last renewal; only the renewal is proof of life.
      now = 700
      await journal.appendItem(
        command,
        { ...shell, input: { command: 'pnpm test', streamed: 'ok' }, state: 'running' },
        { fence: 1 }
      )
      now = 9_000

      await settleStaleStructuredAgentSessionState({
        journal,
        sessionId: 'session-1',
        fence: 2,
        acquisitionGeneration: 'generation-2',
        deathEvidence: {
          kind: 'pid-absent',
          detail: 'recorded pid absent on host',
          observedAt: 9_000,
          ownerFence: 1,
          lastProvenAliveAt: 650
        }
      })

      const items = journal.snapshot().items
      expect(items.map((item) => readAgentJournalTurn(item.body)).find(Boolean)).toMatchObject({
        state: 'interrupted',
        completedAt: 650
      })
      // A probe proves death only once the Orca that held the agent is gone: the restart's row,
      // without the probe's detail, which is Orca's.
      expect(
        items.flatMap((item) => (item.body.kind === 'status' ? [item.body.text] : []))
      ).toEqual(["The agent's session didn't survive the restart. Send a message to continue."])
    } finally {
      await journals.closeAll()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('ends a crashed turn at its last proof of life, not at a send accepted before the proof', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-stale-session-'))
    const journals = createTrackedJournalOpener()
    let now = 100
    try {
      const journal = await journals.open({
        identity: {
          sessionId: 'session-1',
          workspaceId: 'workspace-1',
          hostId: 'local',
          agent: 'codex',
          providerHandle: { kind: 'codex', threadId: THREAD }
        },
        journalDir: root,
        now: () => now
      })
      await journal.appendItem(
        RUNNING_IDENTITY,
        { kind: 'turn', turnId: 'turn-2', state: 'running', startedAt: 100 },
        { fence: 1 }
      )
      now = 200
      await journal.appendItem(
        { ...RUNNING_IDENTITY, ordinal: 1 },
        { kind: 'tool-call', name: 'shell', input: { command: 'pnpm test' }, state: 'running' },
        { fence: 1 }
      )
      const settle = (deathEvidence: AgentSessionDeathEvidence | null) =>
        settleStaleStructuredAgentSessionState({
          journal,
          sessionId: 'session-1',
          fence: 1,
          acquisitionGeneration: null,
          deathEvidence
        })
      // An hour later the relaunch opens the chat before anything proved the owner gone.
      now = 3_600_000
      await settle(null)
      const turn = () => journal.snapshot().items.map((item) => readAgentJournalTurn(item.body))[0]
      expect(turn()).toMatchObject({ state: 'unverifiable' })
      now = 3_605_000
      await journal.appendSubmission({
        clientMessageId: 'send-1',
        payloadFingerprint: 'fingerprint-1',
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'still there?' }] },
        fence: 1,
        handoverRecorded: true
      })
      await journal.resolveDispatch({ clientMessageId: 'send-1', state: 'pending', fence: 1 })
      now = 3_606_000

      await settle({
        kind: 'pid-absent',
        detail: 'gone',
        observedAt: 3_606_000,
        ownerFence: 1,
        lastProvenAliveAt: 210
      })

      expect(turn()).toMatchObject({ state: 'interrupted', completedAt: 210 })
    } finally {
      await journals.closeAll()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('revises an unverifiable turn only from a proof naming its own owner, and only once', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-stale-session-'))
    const journals = createTrackedJournalOpener()
    let now = 100
    try {
      const journal = await journals.open({
        identity: {
          sessionId: 'session-1',
          workspaceId: 'workspace-1',
          hostId: 'local',
          agent: 'codex',
          providerHandle: { kind: 'codex', threadId: THREAD }
        },
        journalDir: root,
        now: () => now
      })
      await journal.appendItem(
        RUNNING_IDENTITY,
        { kind: 'turn', turnId: 'turn-2', state: 'running', startedAt: 100 },
        { fence: 1 }
      )
      now = 400
      // The open, before anything proved the fence-1 owner gone.
      const settle = (deathEvidence: AgentSessionDeathEvidence | null) =>
        settleStaleStructuredAgentSessionState({
          journal,
          sessionId: 'session-1',
          fence: 2,
          acquisitionGeneration: null,
          deathEvidence
        })
      await settle(null)
      now = 9_000
      const turn = () => journal.snapshot().items.map((item) => readAgentJournalTurn(item.body))[0]
      expect(turn()).toMatchObject({ state: 'unverifiable' })

      const unrevised = journal.cursor()
      await expect(settle({ ...PROVEN, ownerFence: 2 })).resolves.toBe(0)
      const { ownerFence: _ownerFence, ...olderBuildProof } = PROVEN
      await expect(settle({ ...olderBuildProof, kind: 'exit-observed' })).resolves.toBe(0)
      expect(journal.cursor()).toEqual(unrevised)
      expect(turn()).toMatchObject({ state: 'unverifiable' })

      await expect(settle(PROVEN)).resolves.toBe(2)
      expect(turn()).toEqual({
        turnId: 'turn-2',
        state: 'interrupted',
        startedAt: 100,
        completedAt: 100
      })
      const revised = journal.cursor()
      await expect(settle(PROVEN)).resolves.toBe(0)
      expect(journal.cursor()).toEqual(revised)
      expect(journal.snapshot().items.filter((item) => item.body.kind === 'status')).toHaveLength(1)
    } finally {
      await journals.closeAll()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('adds one row for a death however many attempts its settle takes to write', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-stale-session-'))
    const journals = createTrackedJournalOpener()
    let now = 100
    try {
      const journal = await journals.open({
        identity: {
          sessionId: 'session-1',
          workspaceId: 'workspace-1',
          hostId: 'local',
          agent: 'codex',
          providerHandle: { kind: 'codex', threadId: THREAD }
        },
        journalDir: root,
        now: () => now
      })
      // Enough running turns that the settle writes two batches, and its retry two again.
      for (let index = 0; index < 399; index++) {
        const turnId = `turn-${index}`
        await journal.appendItem(
          { ...RUNNING_IDENTITY, turnId },
          { kind: 'turn', turnId, state: 'running', startedAt: 100 },
          { fence: 1 }
        )
      }
      now = 9_000
      const settle = () =>
        settleStaleStructuredAgentSessionState({
          journal,
          sessionId: 'session-1',
          fence: 2,
          acquisitionGeneration: null,
          deathEvidence: PROVEN
        })
      const turns = () =>
        journal.snapshot().items.flatMap((item) => readAgentJournalTurn(item.body) ?? [])
      const statusRows = () =>
        journal.snapshot().items.filter((item) => item.body.kind === 'status')
      const append = journal.appendLifecycleBatch.bind(journal)
      const secondBatchFails = vi
        .spyOn(journal, 'appendLifecycleBatch')
        .mockImplementationOnce(append)
        .mockRejectedValueOnce(new Error('disk full'))

      await expect(settle()).rejects.toThrow('disk full')
      secondBatchFails.mockRestore()
      expect(turns().filter((turn) => turn.state === 'running')).toHaveLength(200)
      expect(statusRows()).toHaveLength(1)

      await settle()
      expect(turns().filter((turn) => turn.state !== 'interrupted')).toEqual([])
      expect(statusRows()).toHaveLength(1)
    } finally {
      await journals.closeAll()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('writes nothing when no turn is running and keys on the journal position without a generation', async () => {
    const idle = journalWith([
      lifecycleItem('turn-1', 'completed', 1, { startedAt: 10, completedAt: 20 })
    ])
    await expect(
      settleStaleStructuredAgentSessionState({
        journal: idle.journal,
        sessionId: 'session-1',
        fence: 14,
        acquisitionGeneration: null,
        deathEvidence: null
      })
    ).resolves.toBe(0)
    expect(idle.appendLifecycleBatch).not.toHaveBeenCalled()

    const running = journalWith([lifecycleItem('turn-2', 'running', 2)])
    await settleStaleStructuredAgentSessionState({
      journal: running.journal,
      sessionId: 'session-1',
      fence: 14,
      acquisitionGeneration: null,
      deathEvidence: null
    })
    expect(running.appendLifecycleBatch).toHaveBeenCalledWith(
      expect.objectContaining({ settlementId: 'stale-session:session-1:14:seq-8' })
    )
  })

  describe('the crash boundary writes at most one row', () => {
    const boundaryRows = (batch: ReturnType<typeof journalWith>['appendLifecycleBatch']) =>
      batch.mock.calls.flatMap(([input]) =>
        input.mutations.filter((mutation) => mutation.body?.kind === 'status')
      )

    it('says the session did not survive when it left a send in doubt, with no Retry', async () => {
      const { journal, appendLifecycleBatch } = journalWith([
        lifecycleItem('turn-1', 'completed', 1, { startedAt: 10, completedAt: 20 })
      ])
      await settleStaleStructuredAgentSessionState({
        journal,
        sessionId: 'session-1',
        fence: 14,
        acquisitionGeneration: null,
        deathEvidence: null,
        failureTextContext: { agentName: 'Claude' },
        crashBoundary: { sendsLeftInDoubt: 1 }
      })
      expect(boundaryRows(appendLifecycleBatch)).toEqual([
        {
          kind: 'item',
          identity: { provider: 'orca', clientMessageId: 'crash-boundary:session-1:14' },
          body: {
            kind: 'status',
            tone: 'notice',
            text: "Claude's session didn't survive the restart. Send a message to continue.",
            failure: { kind: 'hostRestarted' }
          }
        }
      ])
    })

    it('says it once for a running turn it could not see end', async () => {
      const { journal, appendLifecycleBatch } = journalWith([
        lifecycleItem('turn-2', 'running', 2, { startedAt: 30 })
      ])
      await settleStaleStructuredAgentSessionState({
        journal,
        sessionId: 'session-1',
        fence: 14,
        acquisitionGeneration: null,
        deathEvidence: null,
        crashBoundary: { sendsLeftInDoubt: 2 }
      })
      expect(boundaryRows(appendLifecycleBatch)).toMatchObject([
        { body: { failure: { kind: 'hostRestarted' } } }
      ])
    })

    it("keeps the observed exit's row instead of adding the restart's", async () => {
      const { journal, appendLifecycleBatch } = journalWith([
        lifecycleItem('turn-2', 'running', 2, { startedAt: 30 })
      ])
      await settleStaleStructuredAgentSessionState({
        journal,
        sessionId: 'session-1',
        fence: 14,
        acquisitionGeneration: null,
        deathEvidence: { kind: 'exit-observed', detail: 'exit', observedAt: 500 },
        crashBoundary: { sendsLeftInDoubt: 1 }
      })
      expect(boundaryRows(appendLifecycleBatch)).toMatchObject([
        { body: { failure: { kind: 'providerExited' } } }
      ])
    })

    it('writes no row with nothing in doubt, or outside a crash boundary', async () => {
      const idle = journalWith([])
      await settleStaleStructuredAgentSessionState({
        journal: idle.journal,
        sessionId: 'session-1',
        fence: 14,
        acquisitionGeneration: null,
        deathEvidence: null,
        crashBoundary: { sendsLeftInDoubt: 0 }
      })
      expect(idle.appendLifecycleBatch).not.toHaveBeenCalled()

      const reacquired = journalWith([lifecycleItem('turn-2', 'running', 2)])
      await settleStaleStructuredAgentSessionState({
        journal: reacquired.journal,
        sessionId: 'session-1',
        fence: 14,
        acquisitionGeneration: 'generation-2',
        deathEvidence: null
      })
      expect(boundaryRows(reacquired.appendLifecycleBatch)).toEqual([])
    })

    it('adds no row when a proof later revises a turn the boundary already explained', async () => {
      const unverifiable: AgentJournalRenderItem = {
        ...lifecycleItem('turn-2', 'running', 2, { startedAt: 30 }),
        body: { kind: 'turn', turnId: 'turn-2', state: 'unverifiable', startedAt: 30 }
      }
      const boundaryRow: AgentJournalRenderItem = {
        itemId: agentJournalItemKey({
          provider: 'orca',
          clientMessageId: 'crash-boundary:session-1:14'
        }),
        revision: 1,
        sequence: 3,
        observedAt: 3,
        body: { kind: 'status', text: "Claude's session didn't survive the restart." }
      }
      const settle = (items: AgentJournalRenderItem[]) => {
        const { journal, appendLifecycleBatch } = journalWith(items)
        return settleStaleStructuredAgentSessionState({
          journal,
          sessionId: 'session-1',
          fence: 14,
          acquisitionGeneration: null,
          deathEvidence: PROVEN
        }).then(() => boundaryRows(appendLifecycleBatch))
      }
      expect(await settle([unverifiable, boundaryRow])).toEqual([])
      // A turn some other release left unverifiable has no row yet: the proof's is the one.
      expect(await settle([unverifiable])).toMatchObject([
        {
          identity: { clientMessageId: 'crash-boundary:session-1:1' },
          body: { failure: { kind: 'hostRestarted' } }
        }
      ])
    })

    it('says an observed exit stopped the agent even with no crash boundary', async () => {
      const { journal, appendLifecycleBatch } = journalWith([
        lifecycleItem('turn-2', 'running', 2, { startedAt: 30 })
      ])
      await settleStaleStructuredAgentSessionState({
        journal,
        sessionId: 'session-1',
        fence: 2,
        acquisitionGeneration: 'generation-2',
        deathEvidence: { kind: 'exit-observed', detail: 'exit', observedAt: 500, ownerFence: 1 }
      })
      expect(boundaryRows(appendLifecycleBatch)).toMatchObject([
        { body: { failure: { kind: 'providerExited' } } }
      ])
    })
  })
})
