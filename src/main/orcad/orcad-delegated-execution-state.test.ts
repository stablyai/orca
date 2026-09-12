import { expect, it, vi } from 'vitest'
import { createOrcadDelegatedExecutionState } from './orcad-delegated-execution-state'
import { setupDelegatedPtyOperations } from './orcad-delegated-pty-operations-fixture'
import { request } from '../../relay/relay-pty-ownership-transfer-delegation-test-fixture'

function setup() {
  let reject!: (error: Error) => void
  const status = vi.fn(
    () =>
      new Promise<never>((_, fail) => {
        reject = fail
      })
  )
  const onError = vi.fn()
  const isActive = vi.fn(() => true)
  const invalidate = vi.fn(() => {
    isActive.mockReturnValue(false)
  })
  const { snapshot } = setupDelegatedPtyOperations()
  const state = createOrcadDelegatedExecutionState({
    identity: snapshot.identity,
    adapter: {} as never,
    client: { status } as never,
    claim: snapshot.delegatedClaim!,
    proof: request(),
    signal: new AbortController().signal,
    onError,
    isActive,
    isReady: () => true,
    deliverExit: vi.fn(),
    invalidate
  })
  return { state, reject: (error: Error) => reject(error), onError, isActive, invalidate, status }
}

it('does not report an in-flight initial status rejection after intentional disconnect', async () => {
  const f = setup()
  f.state.wake()
  expect(f.status).toHaveBeenCalledTimes(1)
  f.isActive.mockReturnValue(false)
  f.reject(new Error('Multiplexer disposed'))
  await new Promise<void>((resolve) => setImmediate(resolve))
  expect(f.onError).not.toHaveBeenCalled()
  expect(f.invalidate).not.toHaveBeenCalled()
})

it('reports an active initial failure and fences even when diagnostics throw', async () => {
  const f = setup()
  f.onError.mockImplementation(() => {
    throw new Error('diagnostic')
  })
  f.state.wake()
  const error = new Error('status unavailable')
  f.reject(error)
  await vi.waitFor(() => expect(f.invalidate).toHaveBeenCalledTimes(1))
  expect(f.onError).toHaveBeenCalledExactlyOnceWith(error)
  f.state.wake()
  expect(f.status).toHaveBeenCalledTimes(1)
})

it('returns explicit refresh failure to its caller and fences without double-reporting', async () => {
  const f = setup()
  const refreshing = f.state.refresh()
  f.reject(new Error('status unavailable'))
  await expect(refreshing).rejects.toThrow('status unavailable')
  expect(f.invalidate).toHaveBeenCalledTimes(1)
  expect(f.onError).not.toHaveBeenCalled()
})
