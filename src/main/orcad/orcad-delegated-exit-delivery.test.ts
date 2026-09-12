import { expect, it, vi } from 'vitest'
import { createOrcadDelegatedExitDelivery } from './orcad-delegated-exit-delivery'
import { setupDelegatedPtyOperations } from './orcad-delegated-pty-operations-fixture'
import { request } from '../../relay/relay-pty-ownership-transfer-delegation-test-fixture'

function setup() {
  const snapshot = { ...setupDelegatedPtyOperations().snapshot }
  snapshot.executionVerdict = 'exited'
  snapshot.exit = {
    verdict: 'exited',
    code: 17,
    eventId: 'exit-1',
    observedAt: '2026-09-06T00:00:00Z'
  }
  snapshot.liveOutputEndSeq = 1
  const output = {
    acceptedEndSeq: 1,
    acknowledgedEndSeq: 1,
    pendingFrames: [] as { seq: number; data: string }[]
  }
  const onExit = vi.fn()
  const isActive = vi.fn(() => true)
  const deliver = createOrcadDelegatedExitDelivery({
    proof: { ...request(), destinationClaim: snapshot.delegatedClaim, afterSeq: 0 },
    adapter: { snapshot: () => snapshot },
    outbox: { load: () => output as never },
    isActive,
    onExit
  })
  return { snapshot, output, onExit, isActive, deliver }
}

it('delivers exactly once after final output is drained', () => {
  const f = setup()
  expect(f.deliver()).toBe(true)
  expect(f.deliver()).toBe(false)
  expect(f.onExit).toHaveBeenCalledExactlyOnceWith({
    identity: f.snapshot.identity,
    exit: f.snapshot.exit,
    surfaceBinding: f.snapshot.surfaceBinding,
    destinationClaim: f.snapshot.delegatedClaim,
    finalOutputSeq: 1
  })
})

it.each(['pending', 'ack-behind', 'extra-output'])('waits for final output when %s', (mode) => {
  const f = setup()
  if (mode === 'pending') {
    f.output.pendingFrames.push({ seq: 1, data: 'tail' })
  }
  if (mode === 'ack-behind') {
    f.output.acknowledgedEndSeq = 0
  }
  if (mode === 'extra-output') {
    f.output.acceptedEndSeq = 2
  }
  expect(f.deliver()).toBe(false)
  expect(f.onExit).not.toHaveBeenCalled()
  f.output.pendingFrames = []
  f.output.acknowledgedEndSeq = f.output.acceptedEndSeq = 1
  expect(f.deliver()).toBe(true)
})

it.each(['disconnect', 'claim', 'unverifiable', 'unpublished'])(
  'does not emit exit for %s',
  (mode) => {
    const f = setup()
    if (mode === 'disconnect') {
      f.isActive.mockReturnValue(false)
    }
    if (mode === 'claim') {
      f.snapshot.delegatedClaim = { generation: 2, claimId: 'new' }
    }
    if (mode === 'unverifiable') {
      f.snapshot.executionVerdict = 'unverifiable'
    }
    if (mode === 'unpublished') {
      f.snapshot.phase = 'committed'
    }
    expect(f.deliver()).toBe(false)
    expect(f.onExit).not.toHaveBeenCalled()
  }
)

it('retries a failed callback and blocks reentrant delivery', () => {
  const f = setup()
  f.onExit.mockImplementationOnce(() => {
    expect(f.deliver()).toBe(false)
    throw new Error('runtime failed')
  })
  expect(f.deliver).toThrow('runtime failed')
  expect(f.deliver()).toBe(true)
  expect(f.deliver()).toBe(false)
  expect(f.onExit).toHaveBeenCalledTimes(2)
})
