import { describe, expect, it } from 'vitest'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import type { AgentJournalRenderItem } from '../../../shared/agent-session-journal-types'
import {
  runningTurnLifecycleRevisions,
  turnVerdictFromDeathEvidence
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

describe('turn verdict from death evidence', () => {
  it('earns an end time only from an observed exit', () => {
    expect(
      turnVerdictFromDeathEvidence({ kind: 'exit-observed', detail: 'exit', observedAt: 500 })
    ).toEqual({ state: 'interrupted', completedAt: 500 })
    expect(
      turnVerdictFromDeathEvidence({ kind: 'pid-absent', detail: 'gone', observedAt: 500 })
    ).toEqual({ state: 'unverifiable' })
    expect(
      turnVerdictFromDeathEvidence({ kind: 'identity-mismatch', detail: 'pid', observedAt: 500 })
    ).toEqual({ state: 'unverifiable' })
    expect(turnVerdictFromDeathEvidence(null)).toEqual({ state: 'unverifiable' })
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
