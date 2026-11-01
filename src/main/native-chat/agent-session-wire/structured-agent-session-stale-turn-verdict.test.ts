import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { expect, it } from 'vitest'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import type { AgentJournalRenderItem } from '../../../shared/agent-session-journal-types'
import { settleStaleStructuredAgentSessionState } from './structured-agent-session-dead-generation-settlement'
import {
  runningTurnLifecycleRevisions,
  turnVerdictFromDeathEvidence,
  UNVERIFIABLE_TURN_VERDICT
} from './structured-agent-session-stale-turn-verdict'

import {
  RUNNING_IDENTITY,
  journalWith,
  legacyLifecycleItem,
  lifecycleItem,
  verdictForTurn
} from './structured-agent-session-stale-verdict-contract-test-fixture'

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
    // Last proof of life bounds completion so downtime is never counted as work.
    expect(verdictForTurn(proof(8_000))).toEqual({ state: 'interrupted', completedAt: 8_000 })
    expect(verdictForTurn(proof(9_500))).toEqual({ state: 'interrupted', completedAt: 9_000 })
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

it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
  'keeps proven exit without an invalid time %s',
  (observedAt) => {
    expect(verdictForTurn({ kind: 'exit-observed', detail: '', observedAt })).toEqual({
      state: 'interrupted'
    })
  }
)

it('leaves a release nothing proved unverifiable', () => {
  expect(verdictForTurn(null)).toEqual({ state: 'unverifiable' })
  expect(verdictForTurn(undefined)).toEqual({ state: 'unverifiable' })
})

it('keeps the rule an older build applied to evidence that names no owner', () => {
  // Legacy ownerless evidence proves only observed exit, never probe results.
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
  // Another owner’s death or unknown turn provenance cannot prove this owner ended.
  for (const [evidence, turnFence] of [
    [{ ...proof, ownerFence: 3 }, 1],
    [{ ...proof, kind: 'exit-observed' as const, ownerFence: 3 }, 1],
    [{ ...proof, ownerFence: 1 }, undefined]
  ] as const) {
    expect(turnVerdictFromDeathEvidence(evidence, turnFence)).toEqual({ state: 'unverifiable' })
  }
})

it('revises only running rows in place and carries an end time only for an observed exit', () => {
  const items = [
    lifecycleItem('turn-1', 'completed', 1, { startedAt: 10, completedAt: 20 }),
    lifecycleItem('turn-2', 'running', 2, { startedAt: 30, completedAt: 99 })
  ]
  expect(runningTurnLifecycleRevisions(items, { state: 'interrupted', completedAt: 40 })).toEqual([
    {
      kind: 'item',
      itemId: agentJournalItemKey(RUNNING_IDENTITY),
      body: {
        kind: 'turn',
        turnId: 'turn-2',
        state: 'interrupted',
        startedAt: 30,
        completedAt: 40
      },
      turnScope: { kind: 'thread' }
    }
  ])
  expect(runningTurnLifecycleRevisions(items, { state: 'unverifiable' })).toEqual([
    expect.objectContaining({
      body: { kind: 'turn', turnId: 'turn-2', state: 'unverifiable', startedAt: 30 }
    })
  ])
})

it('keeps known turn fields and extensions in the rewrite', () => {
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
  expect(items[0]?.body).toHaveProperty('laterField')
  const unverifiable = runningTurnLifecycleRevisions(items, UNVERIFIABLE_TURN_VERDICT)[0]
  expect(unverifiable?.kind === 'item' ? unverifiable.body : null).toEqual({
    ...kept,
    state: 'unverifiable'
  })
})

it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
  'keeps an untimed interruption for %s even when the saved turn has a start',
  (completedAt) => {
    const item = lifecycleItem('turn-2', 'running', 2, { startedAt: 500 })
    expect(
      runningTurnLifecycleRevisions([item], { state: 'interrupted', completedAt })
    ).toMatchObject([{ body: { kind: 'turn', state: 'interrupted', startedAt: 500 } }])
    const [mutation] = runningTurnLifecycleRevisions([item], {
      state: 'interrupted',
      completedAt
    })
    expect(mutation?.kind === 'item' ? mutation.body : null).not.toHaveProperty('completedAt')
  }
)

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
      itemId: agentJournalItemKey(RUNNING_IDENTITY),
      body: { kind: 'turn', turnId: 'turn-2', state: 'unverifiable', startedAt: 30 },
      turnScope: { kind: 'thread' }
    }
  ])
})

it('revises a saved row by its key even when its identity cannot be parsed', () => {
  const item = { ...lifecycleItem('turn-2', 'running', 2), itemId: 'not-an-item-key' }
  expect(runningTurnLifecycleRevisions([item], { state: 'unverifiable' })).toEqual([
    {
      kind: 'item',
      itemId: 'not-an-item-key',
      body: { kind: 'turn', turnId: 'turn-2', state: 'unverifiable' },
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    }
  ])
})

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
    dispatches: [],
    mutations: [
      {
        kind: 'item',
        itemId: agentJournalItemKey(RUNNING_IDENTITY),
        body: { kind: 'turn', turnId: 'turn-2', state: 'unverifiable', startedAt: 30 },
        turnScope: { kind: 'thread' }
      }
    ]
  })
})
