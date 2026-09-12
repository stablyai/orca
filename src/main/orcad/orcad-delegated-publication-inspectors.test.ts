import { beforeEach, expect, it, vi } from 'vitest'
import { catalogActivationFixture } from '../ssh/orcad-catalog-activation-test-fixture'
import { createOrcadDelegatedPublicationInspectors } from './orcad-delegated-publication-inspectors'

const mocked = vi.hoisted(() => ({ activation: vi.fn(), coverage: vi.fn() }))
vi.mock('./orcad-delegated-activation', () => ({
  inspectOrcadPublishedDestinationActivation: mocked.activation
}))
vi.mock('./orcad-delegated-output-coverage', () => ({
  inspectOrcadPublishedDestinationOutputCoverage: mocked.coverage
}))
beforeEach(() => vi.resetAllMocks())

it('waits for exact destination commit before inspecting applied coverage', async () => {
  const f = catalogActivationFixture()
  const committed = Promise.withResolvers<never>()
  const wait = vi.fn(() => committed.promise)
  const registry = {} as never
  const supervisor = { signal: new AbortController().signal } as never
  const connection = {} as never
  const hooks = createOrcadDelegatedPublicationInspectors({
    registry,
    supervisor,
    signal: new AbortController().signal,
    waitForDestinationCommit: wait
  })
  const pending = hooks.inspectPublishedDestinationOutputCoverage(
    f.request.identity,
    7,
    new AbortController().signal
  )
  expect(mocked.coverage).not.toHaveBeenCalled()
  committed.resolve(connection)
  await pending
  expect(mocked.coverage).toHaveBeenCalledWith({
    identity: f.request.identity,
    throughSeq: 7,
    registry,
    supervisor,
    connection,
    signal: expect.any(AbortSignal)
  })
  expect(mocked.activation).not.toHaveBeenCalled()
})

it('retains ordinary activation semantics and combines lifecycle cancellation', async () => {
  const f = catalogActivationFixture()
  const controller = new AbortController()
  const wait = vi.fn(async (_identity: unknown, _signal: AbortSignal) => ({}) as never)
  const hooks = createOrcadDelegatedPublicationInspectors({
    registry: {} as never,
    supervisor: { signal: new AbortController().signal } as never,
    signal: controller.signal,
    waitForDestinationCommit: wait
  })
  await hooks.inspectPublishedDestinationActivation(
    f.request.identity,
    new AbortController().signal
  )
  expect(mocked.activation).toHaveBeenCalledOnce()
  expect(mocked.coverage).not.toHaveBeenCalled()
  controller.abort()
  expect(wait.mock.calls[0][1].aborted).toBe(true)
})
