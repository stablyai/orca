import { describe, expect, it, vi } from 'vitest'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import type { AgentJournalRenderItem } from '../../../shared/agent-session-journal-types'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import {
  runningTurnLifecycleRevisions,
  settleStaleRunningTurnsOnAcquire,
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

describe('stale running turns on a cold acquire', () => {
  function journalWith(items: AgentJournalRenderItem[]) {
    const appendLifecycleBatch = vi.fn(async () => ({ epoch: 'epoch-1', sequence: 9 }))
    const journal = {
      snapshot: () => ({ items }),
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
      settleStaleRunningTurnsOnAcquire({
        journal,
        sessionId: 'session-1',
        fence: 14,
        acquisitionGeneration: 'generation-2'
      })
    ).resolves.toBe(1)

    expect(appendLifecycleBatch).toHaveBeenCalledExactlyOnceWith({
      settlementId: 'stale-turn:session-1:14:generation-2',
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

  it('writes nothing when no turn is running and keys on the journal position without a generation', async () => {
    const idle = journalWith([
      lifecycleItem('turn-1', 'completed', 1, { startedAt: 10, completedAt: 20 })
    ])
    await expect(
      settleStaleRunningTurnsOnAcquire({
        journal: idle.journal,
        sessionId: 'session-1',
        fence: 14,
        acquisitionGeneration: null
      })
    ).resolves.toBe(0)
    expect(idle.appendLifecycleBatch).not.toHaveBeenCalled()

    const running = journalWith([lifecycleItem('turn-2', 'running', 2)])
    await settleStaleRunningTurnsOnAcquire({
      journal: running.journal,
      sessionId: 'session-1',
      fence: 14,
      acquisitionGeneration: null
    })
    expect(running.appendLifecycleBatch).toHaveBeenCalledWith(
      expect.objectContaining({ settlementId: 'stale-turn:session-1:14:seq-8' })
    )
  })
})
