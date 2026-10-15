import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import {
  StructuredAgentSessionTransientRecovery,
  type TransientRecoverySnapshot
} from './structured-agent-session-transient-recovery'

let enabled: boolean
let snapshot: TransientRecoverySnapshot
let controller: StructuredAgentSessionTransientRecovery
let send: ReturnType<
  typeof vi.fn<(sessionId: string, operationId: string, beforeRun: () => void) => Promise<boolean>>
>
let disable: () => void

beforeEach(() => {
  vi.useFakeTimers()
  enabled = true
  snapshot = {
    turnId: 'turn-1',
    fence: 1,
    epoch: 'epoch',
    sequence: 1,
    userItemId: 'user-1',
    error: 'serverOverloaded'
  }
  send = vi.fn(async (_sessionId, _operationId, beforeRun) => {
    beforeRun()
    return true
  })
  controller = new StructuredAgentSessionTransientRecovery({
    onDisabled: (listener) => {
      disable = listener
      return vi.fn()
    },
    enabled: () => enabled,
    snapshot: () => snapshot,
    send,
    logger: { warn: vi.fn(), error: vi.fn() }
  })
})
afterEach(() => {
  controller.dispose()
  vi.useRealTimers()
})

it('does not revive an old scheduled attempt after switching off and back on', async () => {
  controller.completed('session', 'turn-1', 'failure')
  enabled = false
  disable()
  enabled = true
  await vi.advanceTimersByTimeAsync(10_000)
  expect(send).not.toHaveBeenCalled()
})

it('waits for a failed completion, deduplicates it, then sends once', async () => {
  controller.completed('session', 'turn-1', 'failure')
  controller.completed('session', 'turn-1', 'failure')
  await vi.advanceTimersByTimeAsync(9_999)
  expect(send).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(send).toHaveBeenCalledOnce()
})

it('backs off and stops after three consecutive automatic continuations', async () => {
  for (const [i, delay] of [10_000, 30_000, 60_000].entries()) {
    snapshot = { ...snapshot, turnId: `turn-${i}`, sequence: i + 1 }
    controller.completed('session', snapshot.turnId, 'failure')
    await vi.advanceTimersByTimeAsync(delay)
    expect(send).toHaveBeenCalledTimes(i + 1)
    snapshot.userItemId = agentJournalSubmissionKey(send.mock.calls[i]![1])
  }
  snapshot = { ...snapshot, turnId: 'turn-4', sequence: 4 }
  controller.completed('session', 'turn-4', 'failure')
  await vi.advanceTimersByTimeAsync(120_000)
  expect(send).toHaveBeenCalledTimes(3)
})

it.each(['disabled', 'cancelled', 'changed-journal', 'changed-fence', 'disposed'])(
  'cancels pending recovery when %s',
  async (reason) => {
    controller.completed('session', 'turn-1', 'failure')
    if (reason === 'disabled') {
      enabled = false
    }
    if (reason === 'cancelled') {
      controller.cancel('session')
    }
    if (reason === 'changed-journal') {
      snapshot.sequence++
    }
    if (reason === 'changed-fence') {
      snapshot.fence++
    }
    if (reason === 'disposed') {
      controller.dispose()
    }
    await vi.advanceTimersByTimeAsync(10_000)
    expect(send).not.toHaveBeenCalled()
  }
)

it('checks again inside send acceptance when a competing write wins the lock', async () => {
  send.mockImplementationOnce(async (_sessionId, _operationId, beforeRun) => {
    snapshot.sequence++
    beforeRun()
    throw new Error('must not reach delivery')
  })
  controller.completed('session', 'turn-1', 'failure')
  await vi.advanceTimersByTimeAsync(10_000)
  expect(send).toHaveBeenCalledOnce()
  await vi.advanceTimersByTimeAsync(120_000)
  expect(send).toHaveBeenCalledOnce()
})

it('does not recover successful, interrupted, unclassified or mismatched turns', async () => {
  controller.completed('session', 'turn-1', 'success')
  controller.completed('session', 'turn-1', 'interrupted')
  controller.completed('session', 'old-turn', 'failure')
  snapshot.error = null
  controller.completed('session', 'turn-1', 'failure')
  await vi.advanceTimersByTimeAsync(120_000)
  expect(send).not.toHaveBeenCalled()
})

it('starts a fresh budget after a manual message or a successful turn', async () => {
  controller.completed('session', 'turn-1', 'failure')
  await vi.advanceTimersByTimeAsync(10_000)
  snapshot = { ...snapshot, turnId: 'turn-2', userItemId: 'manual-message', sequence: 2 }
  controller.completed('session', 'turn-2', 'failure')
  await vi.advanceTimersByTimeAsync(10_000)
  expect(send).toHaveBeenCalledTimes(2)
  controller.completed('session', 'turn-2', 'success')
})
