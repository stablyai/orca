import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createOrcadDelegatedCommitReconciliation } from './orcad-delegated-commit-reconciliation'
import { recoverOrcadDelegatedCommit } from './orcad-delegated-commit-recovery'
import { identity } from '../../relay/relay-pty-ownership-transfer-delegation-test-fixture'

vi.mock('./orcad-delegated-commit-recovery', () => ({ recoverOrcadDelegatedCommit: vi.fn() }))
type Options = Parameters<typeof createOrcadDelegatedCommitReconciliation>[0]
const receipt = {
  bridgeId: identity.bridgeId,
  receiptId: 'durable',
  acceptedSourceEndSeq: 0,
  committedAt: '2026-09-06T00:00:00.000Z'
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.mocked(recoverOrcadDelegatedCommit).mockReset()
})
afterEach(() => vi.useRealTimers())

function setup() {
  const load = vi.fn(() => ({ phase: 'committed', receipt }))
  const isActive = vi.fn(() => true)
  const onError = vi.fn()
  const reconciler = createOrcadDelegatedCommitReconciliation({
    identity,
    claim: { generation: 1, claimId: 'claim' },
    isActive,
    onError,
    store: { load } as unknown as Options['store'],
    client: {} as Options['client']
  })
  return { reconciler, load, isActive, onError }
}

it('waits for a durable receipt without initiating a commit or polling', async () => {
  const fixture = setup()
  fixture.load.mockReturnValue({ phase: 'prepared', receipt: undefined } as never)
  fixture.reconciler.wake()
  await vi.runAllTimersAsync()
  expect(recoverOrcadDelegatedCommit).not.toHaveBeenCalled()
  expect(fixture.reconciler.isReconciled()).toBe(false)
  expect(vi.getTimerCount()).toBe(0)
})

it('waits for source commit acknowledgement and removes its abort listener on success', async () => {
  const fixture = setup()
  const controller = new AbortController()
  const remove = vi.spyOn(controller.signal, 'removeEventListener')
  vi.mocked(recoverOrcadDelegatedCommit).mockResolvedValue({ phase: 'pending-output', receipt })
  const done = vi.fn()
  const pending = fixture.reconciler.waitForReconciled(controller.signal).then(done)
  await vi.advanceTimersByTimeAsync(0)
  expect(done).not.toHaveBeenCalled()
  vi.mocked(recoverOrcadDelegatedCommit).mockResolvedValue({ phase: 'committed', receipt })
  fixture.reconciler.wake()
  await pending
  expect(done).toHaveBeenCalledOnce()
  expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
})

it('cancels a readiness waiter without treating cancellation as commit acknowledgement', async () => {
  const fixture = setup()
  vi.mocked(recoverOrcadDelegatedCommit).mockResolvedValue({ phase: 'pending-output', receipt })
  const controller = new AbortController()
  const pending = fixture.reconciler.waitForReconciled(controller.signal)
  const rejected = expect(pending).rejects.toThrow('shutdown')
  controller.abort(new Error('shutdown'))
  await rejected
  expect(fixture.reconciler.isReconciled()).toBe(false)
})

it('coalesces output wakeups and waits for another ACK when output is behind', async () => {
  const fixture = setup()
  vi.mocked(recoverOrcadDelegatedCommit).mockResolvedValue({ phase: 'pending-output', receipt })
  fixture.reconciler.wake()
  fixture.reconciler.wake()
  await vi.runAllTimersAsync()
  expect(recoverOrcadDelegatedCommit).toHaveBeenCalledOnce()
  expect(fixture.reconciler.isReconciled()).toBe(false)
  expect(vi.getTimerCount()).toBe(0)
  vi.mocked(recoverOrcadDelegatedCommit).mockResolvedValue({ phase: 'committed', receipt })
  fixture.reconciler.wake()
  await vi.runAllTimersAsync()
  expect(fixture.reconciler.isReconciled()).toBe(true)
  expect(recoverOrcadDelegatedCommit).toHaveBeenCalledTimes(2)
  fixture.reconciler.wake()
  await vi.runAllTimersAsync()
  expect(recoverOrcadDelegatedCommit).toHaveBeenCalledTimes(2)
})

it('retains an ACK arriving during an in-flight status check without overlapping recovery', async () => {
  const fixture = setup()
  let finish!: (value: Awaited<ReturnType<typeof recoverOrcadDelegatedCommit>>) => void
  vi.mocked(recoverOrcadDelegatedCommit).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  vi.mocked(recoverOrcadDelegatedCommit).mockResolvedValue({ phase: 'committed', receipt })
  fixture.reconciler.wake()
  await vi.advanceTimersByTimeAsync(0)
  fixture.reconciler.wake()
  fixture.reconciler.wake()
  expect(recoverOrcadDelegatedCommit).toHaveBeenCalledOnce()
  finish({ phase: 'pending-output', receipt })
  await vi.runAllTimersAsync()
  expect(recoverOrcadDelegatedCommit).toHaveBeenCalledTimes(2)
  expect(fixture.reconciler.isReconciled()).toBe(true)
})

it('reports failure once and waits for explicit progress to retry', async () => {
  const fixture = setup()
  vi.mocked(recoverOrcadDelegatedCommit).mockRejectedValue(new Error('uncertain source'))
  fixture.reconciler.wake()
  await vi.runAllTimersAsync()
  expect(fixture.onError).toHaveBeenCalledOnce()
  expect(recoverOrcadDelegatedCommit).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
  fixture.reconciler.wake()
  await vi.runAllTimersAsync()
  expect(recoverOrcadDelegatedCommit).toHaveBeenCalledTimes(2)
})

it('ignores late successful reconciliation after connection loss', async () => {
  const fixture = setup()
  vi.mocked(recoverOrcadDelegatedCommit).mockImplementation(async () => {
    fixture.isActive.mockReturnValue(false)
    return { phase: 'committed', receipt }
  })
  fixture.reconciler.wake()
  await vi.runAllTimersAsync()
  expect(fixture.reconciler.isReconciled()).toBe(false)
  fixture.reconciler.wake()
  await vi.runAllTimersAsync()
  expect(recoverOrcadDelegatedCommit).toHaveBeenCalledOnce()
  expect(fixture.onError).not.toHaveBeenCalled()
})
