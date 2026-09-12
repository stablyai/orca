import { expect, it, vi } from 'vitest'
import { INSPECT_CAPTURED_CATALOG_OUTPUT_COVERAGE_METHOD as method } from './pty-catalog-output-coverage'
import { catalogActivationFixture } from '../../../ssh/orcad-catalog-activation-test-fixture'
import type { RpcContext } from '../core'
import { ALL_RPC_METHODS } from './index'

function fixture() {
  const f = catalogActivationFixture()
  const coverage = {
    throughSeq: 4,
    acknowledgedEndSeq: 5,
    modelThroughSeq: 5,
    modelSequenceEnd: 100
  }
  const inspect = vi.fn().mockResolvedValue({ ...f.activation, coverage })
  const read = vi.fn().mockReturnValue({ state: 'committed', ...f.result.catalog })
  const supports = vi.fn(() => true)
  const context: RpcContext = {
    clientKind: 'runtime',
    pairedDeviceId: 'paired',
    connectionId: 'socket',
    signal: new AbortController().signal,
    runtime: {
      supportsCapturedCatalogOutputCoverage: supports,
      getOrcadMigrationCatalogState: read,
      inspectCapturedPtyDestinationOutputCoverage: inspect
    } as never
  }
  const call = (patch: Partial<RpcContext> = {}, request: object = {}) =>
    Promise.resolve().then(() =>
      method.handler(
        method.params!.parse({ version: 1, ...f.request, throughSeq: 4, ...request }),
        { ...context, ...patch }
      )
    )
  return { ...f, coverage, inspect, read, supports, call }
}

it('registers exactly once and returns publication-bound applied coverage', async () => {
  const f = fixture()
  expect(ALL_RPC_METHODS.filter((entry) => entry.name === method.name)).toHaveLength(1)
  expect(await f.call()).toEqual({ ...f.result, coverage: f.coverage })
  expect(f.inspect).toHaveBeenCalledWith(f.request.identity, 4, expect.any(AbortSignal))
})

it.each([
  { clientKind: 'mobile' as const },
  { pairedDeviceId: undefined },
  { connectionId: undefined },
  { signal: undefined },
  { signal: AbortSignal.abort() }
])('refuses unauthorized caller %j', async (patch) => {
  const f = fixture()
  await expect(f.call(patch)).rejects.toThrow()
  expect(f.inspect).not.toHaveBeenCalled()
})

it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN])(
  'refuses invalid sequence %s before inspection',
  async (throughSeq) => {
    const f = fixture()
    await expect(f.call({}, { throughSeq })).rejects.toThrow()
    expect(f.inspect).not.toHaveBeenCalled()
  }
)

it('refuses old lifecycle support without an activation fallback', async () => {
  const f = fixture()
  f.supports.mockReturnValue(false)
  await expect(f.call()).rejects.toThrow('unavailable')
  expect(f.inspect).not.toHaveBeenCalled()
})

it('rejects catalog change during coverage inspection', async () => {
  const f = fixture()
  f.read
    .mockReturnValueOnce({ state: 'committed', ...f.result.catalog })
    .mockReturnValue({ state: 'absent' })
  await expect(f.call()).rejects.toThrow('catalog_changed')
})

it('rejects coverage below the requested boundary', async () => {
  const f = fixture()
  f.inspect.mockResolvedValue({
    ...f.activation,
    coverage: { ...f.coverage, acknowledgedEndSeq: 3 }
  })
  await expect(f.call()).rejects.toThrow()
})

it('rejects publication substitution', async () => {
  const f = fixture()
  f.inspect.mockResolvedValue({
    ...f.activation,
    coverage: f.coverage,
    publicationReceipt: { ...f.activation.publicationReceipt, publicationReceiptId: 'other' }
  })
  await expect(f.call()).rejects.toThrow()
})
