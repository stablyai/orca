import { expect, it } from 'vitest'
import { agentJournalItemKey } from '../../../../../shared/agent-session/journal/agent-session-journal-item-key'
import {
  runningTurnLifecycleRevisions,
  turnVerdictFromDeathEvidence
} from '../structured-agent-session-stale-turn-verdict'
import {
  RUNNING_IDENTITY,
  legacyLifecycleItem,
  lifecycleItem,
  verdictForTurn
} from './structured-agent-session-stale-verdict-contract-test-fixture'

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
