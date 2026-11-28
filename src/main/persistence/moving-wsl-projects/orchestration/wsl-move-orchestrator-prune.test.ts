import { describe, expect, it, vi } from 'vitest'
import type {
  WslMoveOrchestratorRecord,
  WslMoveOrchestratorState
} from '../../../../shared/wsl-move/wsl-move-orchestrator-types'
import { pruneWslMoveOrchestratorRecords } from './wsl-move-orchestrator-prune'
import { newWslMoveOrchestratorRecord } from './wsl-move-orchestrator-transitions'

const lostHold: WslMoveOrchestratorState = {
  kind: 'parked',
  reason: 'declined',
  cause: 'released-here',
  stateLost: true
}

function recordIn(distro: string, state: WslMoveOrchestratorState): WslMoveOrchestratorRecord {
  return { ...newWslMoveOrchestratorRecord(distro, '1.0.0', 1_000), state }
}

async function prune(
  records: Map<string, WslMoveOrchestratorRecord>,
  inUse: (distro: string) => boolean
): Promise<string[]> {
  const dropped: string[] = []
  await pruneWslMoveOrchestratorRecords({
    records,
    isBusy: () => false,
    isDisposed: () => false,
    isDistroInUse: vi.fn(inUse),
    drop: (key) => {
      dropped.push(key)
      records.delete(key)
    }
  })
  return dropped
}

describe('pruneWslMoveOrchestratorRecords', () => {
  it('drops a stateLost hold once its distro is definitely unused', async () => {
    const records = new Map([['debian', recordIn('Debian', lostHold)]])
    expect(await prune(records, () => false)).toEqual(['debian'])
  })

  it('keeps a stateLost hold while its distro is in use', async () => {
    const records = new Map([['ubuntu', recordIn('Ubuntu', lostHold)]])
    expect(await prune(records, () => true)).toEqual([])
    expect(records.get('ubuntu')?.state).toEqual(lostHold)
  })

  it("never drops the user's own decline or Not now, even on an unused distro", async () => {
    const records = new Map([
      ['a', recordIn('A', { kind: 'parked', reason: 'declined', cause: 'released-here' })],
      ['b', recordIn('B', { kind: 'parked', reason: 'declined', cause: 'removed' })],
      ['c', recordIn('C', { kind: 'parked', reason: 'not-now', until: 9_999 })]
    ])
    expect(await prune(records, () => false)).toEqual([])
    expect(records.size).toBe(3)
  })
})
