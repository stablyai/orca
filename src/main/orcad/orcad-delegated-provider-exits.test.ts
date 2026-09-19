import { expect, it, vi } from 'vitest'
import { OrcadDelegatedProviderExits } from './orcad-delegated-provider-exits'
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
  const output = { acceptedEndSeq: 0, acknowledgedEndSeq: 0, pendingFrames: [] as unknown[] }
  const onExit = vi.fn()
  const onError = vi.fn()
  const isActive = vi.fn(() => true)
  const events = new OrcadDelegatedProviderExits({ onExit, onError, isActive })
  const deliver = createOrcadDelegatedExitDelivery({
    proof: { ...request(), destinationClaim: snapshot.delegatedClaim, afterSeq: 0 },
    adapter: { snapshot: () => snapshot },
    outbox: { load: () => output as never },
    isActive,
    onExit: events.accept
  })
  return { snapshot, output, onExit, onError, isActive, events, deliver }
}

it('notifies only after runtime acceptance and replays confirmed exit to late subscribers', () => {
  const f = setup()
  const listener = vi.fn(() => expect(f.onExit).toHaveBeenCalledTimes(1))
  f.events.onExit(listener)
  expect(f.deliver()).toBe(true)
  expect(f.deliver()).toBe(false)
  expect(listener).toHaveBeenCalledExactlyOnceWith({
    id: f.snapshot.identity.terminalId,
    incarnationId: f.snapshot.identity.incarnationId,
    code: 17
  })
  const late = vi.fn()
  f.events.onExit(late)
  expect(late).toHaveBeenCalledExactlyOnceWith({
    id: f.snapshot.identity.terminalId,
    incarnationId: f.snapshot.identity.incarnationId,
    code: 17
  })
})

it('keeps rejected runtime delivery retryable without notifying provider consumers', () => {
  const f = setup()
  const listener = vi.fn()
  f.events.onExit(listener)
  f.onExit.mockImplementationOnce(() => {
    throw new Error('rejected')
  })
  expect(f.deliver).toThrow('rejected')
  expect(listener).not.toHaveBeenCalled()
  expect(f.deliver()).toBe(true)
  expect(listener).toHaveBeenCalledTimes(1)
})

it('waits for durable final output and never maps unverifiable state to exit', () => {
  const f = setup()
  const listener = vi.fn()
  f.events.onExit(listener)
  f.output.pendingFrames.push({ seq: 1 })
  expect(f.deliver()).toBe(false)
  f.output.pendingFrames = []
  f.snapshot.executionVerdict = 'unverifiable'
  expect(f.deliver()).toBe(false)
  f.isActive.mockReturnValue(false)
  f.events.dispose()
  expect(listener).not.toHaveBeenCalled()
})

it('contains observer and diagnostic failures, and honors unsubscribe', () => {
  const f = setup()
  const removed = vi.fn()
  f.events.onExit(removed)()
  f.events.onExit(() => {
    throw new Error('observer')
  })
  f.onError.mockImplementation(() => {
    throw new Error('diagnostic')
  })
  const listener = vi.fn()
  f.events.onExit(listener)
  expect(f.deliver()).toBe(true)
  expect(listener).toHaveBeenCalledTimes(1)
  expect(removed).not.toHaveBeenCalled()
  expect(f.onError).toHaveBeenCalledTimes(1)
})

it('fences remaining and late listeners when an observer disposes the connection', () => {
  const f = setup()
  f.events.onExit(() => f.events.dispose())
  const listener = vi.fn()
  f.events.onExit(listener)
  expect(f.deliver()).toBe(true)
  f.events.onExit(listener)
  expect(listener).not.toHaveBeenCalled()
})
