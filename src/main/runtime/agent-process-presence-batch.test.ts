import { describe, expect, it, vi } from 'vitest'
import {
  AGENT_PRESENCE_BATCH_LIMIT,
  probeAgentProcessPresenceBatch,
  type AgentPresenceBatchDeps
} from './agent-process-presence-batch'
import type { AgentProcessIdentity } from '../../shared/agent-process-presence'

const id = (pid: number, startTime = `s${pid}`): AgentProcessIdentity => ({
  pid,
  platform: 'darwin',
  startTime
})

describe('probeAgentProcessPresenceBatch', () => {
  it('macOS: one bounded ps per 32 PIDs; gone, reused, zombie and stopped are classified', async () => {
    const readDarwinBatch = vi.fn(async (pids: readonly number[]) => {
      const rows = new Map<
        number,
        { verdict: 'live'; startTime: string; zombie: boolean; stopped?: boolean }
      >()
      for (const pid of pids) {
        if (pid === 2) {
          continue
        }
        rows.set(pid, {
          verdict: 'live',
          startTime: pid === 3 ? 'reused' : `s${pid}`,
          zombie: pid === 4,
          stopped: pid === 5
        })
      }
      return rows
    })
    const deps: AgentPresenceBatchDeps = {
      platform: 'darwin',
      readDarwinBatch,
      probeOne: vi.fn(),
      isMissing: (pid) => pid === 2
    }
    const identities = Array.from({ length: AGENT_PRESENCE_BATCH_LIMIT + 3 }, (_, index) =>
      id(index + 1)
    )
    const verdicts = await probeAgentProcessPresenceBatch(identities, deps)
    expect(readDarwinBatch).toHaveBeenCalledTimes(2)
    expect(readDarwinBatch.mock.calls[0]![0]).toHaveLength(AGENT_PRESENCE_BATCH_LIMIT)
    expect(readDarwinBatch.mock.calls[1]![0]).toHaveLength(3)
    expect(verdicts.slice(0, 6)).toEqual([
      'live',
      'exited',
      'exited',
      'exited',
      'unverifiable',
      'live'
    ])
    expect(deps.probeOne).not.toHaveBeenCalled()
  })

  it('macOS: a few PIDs are probed one at a time, never with a whole-table ps', async () => {
    const readDarwinBatch = vi.fn()
    const probeOne = vi.fn(async () => 'live' as const)
    await probeAgentProcessPresenceBatch([id(1), id(2), id(3)], {
      platform: 'darwin',
      readDarwinBatch,
      probeOne,
      isMissing: () => false
    })
    expect(probeOne).toHaveBeenCalledTimes(3)
    expect(readDarwinBatch).not.toHaveBeenCalled()
  })

  it('an unreadable batch proves nothing', async () => {
    const identities = Array.from({ length: 9 }, (_, index) => id(index + 1))
    const verdicts = await probeAgentProcessPresenceBatch(identities, {
      platform: 'darwin',
      readDarwinBatch: async () => null,
      probeOne: vi.fn(),
      isMissing: () => true
    })
    expect(verdicts).toEqual(identities.map(() => 'unverifiable'))
  })

  it('Linux: targeted /proc reads per PID, no ps', async () => {
    const probeOne = vi.fn(async () => 'live' as const)
    const readDarwinBatch = vi.fn()
    await probeAgentProcessPresenceBatch([id(1), id(2)], {
      platform: 'linux',
      readDarwinBatch,
      probeOne,
      isMissing: () => false
    })
    expect(probeOne).toHaveBeenCalledTimes(2)
    expect(readDarwinBatch).not.toHaveBeenCalled()
  })
})
