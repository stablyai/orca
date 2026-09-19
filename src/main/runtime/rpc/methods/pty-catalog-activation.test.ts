import { expect, it, vi } from 'vitest'
import { INSPECT_CAPTURED_CATALOG_ACTIVATION_METHOD as method } from './pty-catalog-activation'
import { catalogActivationFixture } from '../../../ssh/orcad-catalog-activation-test-fixture'
import type { RpcContext } from '../core'
import { ALL_RPC_METHODS } from './index'

function fixture() {
  const f = catalogActivationFixture()
  const inspect = vi.fn().mockResolvedValue(f.activation)
  const read = vi.fn().mockReturnValue({ state: 'committed', ...f.result.catalog })
  const context: RpcContext = {
    clientKind: 'runtime',
    pairedDeviceId: 'paired',
    connectionId: 'socket',
    signal: new AbortController().signal,
    runtime: {
      supportsCapturedCatalogActivation: () => true,
      getOrcadMigrationCatalogState: read,
      inspectCapturedPtyDestinationActivation: inspect
    } as never
  }
  const call = (patch: Partial<RpcContext> = {}) =>
    Promise.resolve().then(() =>
      method.handler(method.params!.parse({ version: 1, ...f.request }), { ...context, ...patch })
    )
  return { ...f, inspect, read, call }
}

it('registers once and returns only catalog-bound activation fields', async () => {
  const f = fixture()
  expect(ALL_RPC_METHODS.filter((entry) => entry.name === method.name)).toHaveLength(1)
  expect(await f.call()).toEqual(f.result)
})

it.each([
  { clientKind: 'mobile' as const },
  { pairedDeviceId: undefined },
  { connectionId: undefined },
  { signal: undefined },
  { signal: AbortSignal.abort() }
])('refuses unpaired, non-runtime or canceled callers %j', async (patch) => {
  const f = fixture()
  await expect(f.call(patch)).rejects.toThrow()
  expect(f.inspect).not.toHaveBeenCalled()
  expect(f.read).not.toHaveBeenCalled()
})

it('refuses a staged catalog before contacting its source', async () => {
  const f = fixture()
  f.read.mockReturnValue({ state: 'staged', ...f.result.catalog })
  await expect(f.call()).rejects.toThrow('catalog_not_committed')
  expect(f.inspect).not.toHaveBeenCalled()
})

it('rejects catalog changes during source inspection', async () => {
  const f = fixture()
  f.read
    .mockReturnValueOnce({ state: 'committed', ...f.result.catalog })
    .mockReturnValue({ state: 'absent' })
  await expect(f.call()).rejects.toThrow('catalog_changed')
})

it('rejects a catalog not matching the terminal durable admission', async () => {
  const f = fixture()
  f.inspect.mockResolvedValue({ ...f.activation, catalogAdmission: null })
  await expect(f.call()).rejects.toThrow('catalog_changed')
})
