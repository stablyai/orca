import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { MethodHandler, RelayDispatcher } from './dispatcher'
import { createOrcadModelImportFixture } from '../main/orcad/orcad-model-import-test-fixture'
import {
  makeDelegatedRelay,
  identity,
  request,
  context
} from './relay-pty-ownership-transfer-delegation-test-fixture'
import { PTY_OWNERSHIP_CAPTURE_IMPORT_ACK_METHOD as ACK } from '../shared/pty-ownership-capture-import-receipt'
import { PTY_OWNERSHIP_TRANSFER_DESTINATION_SUBSCRIBE_METHOD as SUBSCRIBE } from '../shared/pty-ownership-transfer-destination-claim'

let directory: string
beforeEach(() => {
  vi.useFakeTimers()
  directory = mkdtempSync(join(tmpdir(), 'orca-import-ack-'))
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
  rmSync(directory, { recursive: true, force: true })
})
function setup(enabled = true, laterOutput = true) {
  const fixture = createOrcadModelImportFixture(directory)
  fixture.outbox.recordInitialModelSnapshot(identity, fixture.model)
  const create = () =>
    makeDelegatedRelay(fixture.sourceStore, {
      enableDestinationOutputRetention: true,
      enableDestinationOutputRoutes: true,
      enableCaptureImportAcknowledgement: enabled
    })
  const register = (source: ReturnType<typeof create>) => {
    const handlers = new Map<string, MethodHandler>()
    source.register({
      onRequest: (method: string, handler: MethodHandler) => handlers.set(method, handler),
      onClientDetached: () => () => {},
      onDisposed: () => () => {},
      onLegacyPtyCapacity: () => () => {},
      publishProducerNotification: () => true
    } as unknown as RelayDispatcher)
    return handlers
  }
  const source = create()
  if (laterOutput) {
    source.observeOutput(identity.terminalId, 'later')
  }
  source.claimDestination(request(), context())
  const handlers = register(source)
  const receipt = {
    version: 1,
    identity,
    throughSeq: 1,
    modelSha256: fixture.selection.modelSha256
  }
  const value = (generation = 1) => ({
    ...request(generation),
    destinationClaim: { generation, claimId: `claim-${generation}` },
    receipt
  })
  const call = (params = value(), ctx = context()) => handlers.get(ACK)!(params, ctx)
  return { ...fixture, source, create, register, handlers, receipt, value, call }
}

it('durably replaces only the imported prefix and preserves later frames across restart', async () => {
  const fixture = setup()
  expect(fixture.source.inspectDestination(request(), context())).toMatchObject({
    captureImportAckVersion: 1
  })
  expect(await fixture.call()).toEqual({ ...identity, version: 1, receipt: fixture.receipt })
  expect(fixture.sourceStore.loadAll()[0]).toMatchObject({
    replayStartSeq: 2,
    sourceOutputEndSeq: 2
  })
  expect(fixture.sourceStore.loadAll()[0].history.frames).toMatchObject([{ seq: 2, data: 'later' }])
  const reopened = fixture.create()
  expect(reopened.inspectDestination(request(), context())).toMatchObject({
    destinationAcknowledgedSeq: 1
  })
  reopened.claimDestination(request(2), context())
  const handlers = fixture.register(reopened)
  const save = vi.spyOn(fixture.sourceStore, 'save')
  expect(await handlers.get(ACK)!(fixture.value(2), context())).toMatchObject({
    receipt: fixture.receipt
  })
  expect(save).not.toHaveBeenCalled()
  reopened.observeOutput(identity.terminalId, 'new')
  expect(fixture.sourceStore.loadAll()[0].history.frames).toMatchObject([
    { seq: 2, data: 'later' },
    { seq: 3, data: 'new' }
  ])
})

it('does not register or advertise initial-model ACK without opt-in', () => {
  const fixture = setup(false)
  expect(fixture.handlers.has(ACK)).toBe(false)
  expect(fixture.source.inspectDestination(request(), context())).not.toHaveProperty(
    'captureImportAckVersion'
  )
  expect(fixture.sourceStore.loadAll()[0].history.frames).toHaveLength(2)
})

it('persists an imported prefix with no later frames and preserves the next sequence', async () => {
  const fixture = setup(true, false)
  await fixture.call()
  expect(fixture.sourceStore.loadAll()[0]).toMatchObject({
    replayStartSeq: 2,
    history: { nextSeq: 2, frames: [] }
  })
  const reopened = fixture.create()
  expect(reopened.inspectDestination(request(), context())).toMatchObject({
    destinationAcknowledgedSeq: 1
  })
  reopened.observeOutput(identity.terminalId, 'next')
  expect(fixture.sourceStore.loadAll()[0].history.frames).toMatchObject([{ seq: 2, data: 'next' }])
})

it.each(['client', 'transport', 'principal', 'stale', 'claim', 'credential'])(
  'refuses %s authority without trimming output',
  async (mode) => {
    const fixture = setup()
    const ctx = context(mode === 'client' ? 99 : 2, mode === 'transport' ? 99 : 1)
    if (mode === 'principal') {
      ctx.sessionIdentity = { ...ctx.sessionIdentity!, principal: 'other' }
    }
    if (mode === 'stale') {
      ctx.isStale = () => true
    }
    const params = fixture.value(mode === 'claim' ? 2 : 1)
    if (mode === 'credential') {
      params.credential = '0'.repeat(64)
    }
    await expect(fixture.call(params, ctx)).rejects.toThrow()
    expect(fixture.sourceStore.loadAll()[0].history.frames).toHaveLength(2)
  }
)

it.each([
  { throughSeq: 0 },
  { throughSeq: 2 },
  { modelSha256: 'b'.repeat(64) },
  { identity: { ...identity, destinationRuntimeId: 'other' } }
])('refuses a mismatched import receipt: %j', async (patch) => {
  const fixture = setup()
  const value = { ...fixture.value(), receipt: { ...fixture.receipt, ...patch } }
  await expect(fixture.call(value)).rejects.toThrow()
  expect(fixture.sourceStore.loadAll()[0].history.frames).toHaveLength(2)
})

it('does not move the baseline underneath an active output subscription', async () => {
  const fixture = setup()
  await fixture.handlers.get(SUBSCRIBE)!({ ...fixture.value(), afterSeq: 0 }, context())
  await expect(fixture.call()).rejects.toThrow('route_active')
  expect(fixture.sourceStore.loadAll()[0].history.frames).toHaveLength(2)
})

it.each(['before', 'after'])(
  'fences an uncertain %s-write ACK and safely retries after reopen',
  async (mode) => {
    const fixture = setup()
    const save = fixture.sourceStore.save.bind(fixture.sourceStore)
    const fault = vi.spyOn(fixture.sourceStore, 'save').mockImplementation((record) => {
      if (mode === 'after') {
        save(record)
      }
      throw new Error('uncertain write')
    })
    await expect(fixture.call()).rejects.toThrow('uncertain write')
    await expect(fixture.call()).rejects.toThrow('unavailable')
    fault.mockRestore()
    const reopened = fixture.create()
    expect(reopened.inspectDestination(request(), context())).toMatchObject({
      destinationAcknowledgedSeq: mode === 'before' ? 0 : 1
    })
    reopened.claimDestination(request(2), context())
    await fixture.register(reopened).get(ACK)!(fixture.value(2), context())
    expect(fixture.sourceStore.loadAll()[0].history.frames).toMatchObject([
      { seq: 2, data: 'later' }
    ])
  }
)
