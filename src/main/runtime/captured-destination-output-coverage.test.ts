import { expect, it, vi } from 'vitest'
import { catalogActivationFixture } from '../ssh/orcad-catalog-activation-test-fixture'
import { inspectRuntimeCapturedDestinationOutputCoverage as inspect } from './captured-destination-output-coverage'
import type { RuntimeCapturedPtyDestinationLifecycle } from './runtime-ownership-transfer-contracts'

function fixture() {
  const f = catalogActivationFixture()
  const hook = vi
    .fn()
    .mockResolvedValue({
      ...f.activation,
      coverage: { throughSeq: 1, acknowledgedEndSeq: 1, modelThroughSeq: 1, modelSequenceEnd: 100 }
    })
  let lifecycle = {
    inspectPublishedDestinationOutputCoverage: hook
  } as unknown as RuntimeCapturedPtyDestinationLifecycle
  const options = {
    identity: f.request.identity,
    throughSeq: 1,
    runtimeId: f.request.identity.destinationRuntimeId,
    signal: new AbortController().signal,
    getLifecycle: () => lifecycle,
    supportsPublication: vi.fn(() => true)
  }
  return {
    options,
    hook,
    replace: () => {
      lifecycle = { ...lifecycle }
    }
  }
}

it('forwards the exact requested boundary to the installed lifecycle', async () => {
  const f = fixture()
  await inspect(f.options)
  expect(f.hook).toHaveBeenCalledWith(f.options.identity, 1, f.options.signal)
})

it('refuses a replaced lifecycle after inspection', async () => {
  const f = fixture()
  f.hook.mockImplementation(async () => {
    f.replace()
    return {}
  })
  await expect(inspect(f.options)).rejects.toThrow('unavailable')
})

it('refuses old lifecycle support without calling activation', async () => {
  const f = fixture()
  const activation = vi.fn()
  await expect(
    inspect({
      ...f.options,
      getLifecycle: () => ({ inspectPublishedDestinationActivation: activation }) as never
    })
  ).rejects.toThrow('unavailable')
  expect(activation).not.toHaveBeenCalled()
})

it.each([-1, 0.1, Number.MAX_SAFE_INTEGER + 1])(
  'refuses invalid boundary %s',
  async (throughSeq) => {
    const f = fixture()
    await expect(inspect({ ...f.options, throughSeq })).rejects.toThrow('unavailable')
    expect(f.hook).not.toHaveBeenCalled()
  }
)
