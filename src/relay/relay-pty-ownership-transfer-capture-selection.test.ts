import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { RelayPtyOwnershipTransferFileStore } from './relay-pty-ownership-transfer-file-store'
import {
  identity,
  preparation,
  makeDelegatedRelay,
  context,
  request
} from './relay-pty-ownership-transfer-delegation-test-fixture'
import { parsePtyOwnershipCaptureBoundary } from '../shared/pty-ownership-capture-boundary'
import type { RelayPtyOwnershipTransferDurableRecord } from './relay-pty-ownership-transfer-adapter-contract'

let directory: string
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-capture-selection-'))
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(directory, { recursive: true, force: true })
})
const boundary = parsePtyOwnershipCaptureBoundary(
  {
    version: 1,
    identity,
    throughSeq: 1,
    delivery: {
      id: identity.terminalId,
      ptyIncarnation: identity.incarnationId,
      providerGeneration: 1,
      clientGeneration: 2,
      ownerGeneration: identity.sourceOwnerGeneration,
      deliveryToken: 'captured-delivery',
      state: 'active',
      windowSu: 1024,
      receivedEndSu: 5,
      sentEndSu: 5,
      creditedEndSu: 5,
      generationClosed: false,
      exitPublished: false
    }
  },
  identity
)
const baseline = { version: 1, boundary, modelSha256: 'a'.repeat(64) }

function setup() {
  const store = new RelayPtyOwnershipTransferFileStore(directory)
  const adapter = makeDelegatedRelay(store, { enableDestinationOutputRetention: true })
  adapter.prepare(preparation)
  adapter.observeOutput(identity.terminalId, 'one🙂')
  const inspect = vi.fn((): typeof boundary | null => boundary)
  const select = (value: unknown = baseline) =>
    adapter.selectCaptureBaseline(identity, value, inspect)
  return { store, adapter, select, inspect }
}

it('retains issued boundaries before selection and through later output and journal reopen', () => {
  const fixture = setup()
  const before = fixture.store.loadAll()[0]
  expect(fixture.adapter.retainCaptureBoundary(identity, boundary)).toEqual(boundary)
  const issued = fixture.store.loadAll()[0]
  expect(issued).toMatchObject({
    version: 10,
    captureJournalVersion: 4,
    issuedCaptureBoundaries: [boundary]
  })
  expect(issued.captureBaseline).toBeUndefined()
  expect(issued.history).toEqual(before.history)
  expect(issued.phase).toBe('prepared')
  fixture.adapter.observeOutput(identity.terminalId, 'later')
  const reopened = makeDelegatedRelay(fixture.store, { enableDestinationOutputRetention: true })
  expect(reopened.inspectDestination(request(), context()).captureBaseline).toBeUndefined()
  expect(fixture.store.loadAll()[0].issuedCaptureBoundaries).toEqual([boundary])
  expect(() => reopened.retainCaptureBoundary(identity, boundary)).toThrow('boundary_unavailable')
})

it('deduplicates issued boundaries and preserves them through baseline selection', () => {
  const fixture = setup()
  fixture.adapter.retainCaptureBoundary(identity, boundary)
  const save = vi.spyOn(fixture.store, 'save')
  fixture.adapter.retainCaptureBoundary(identity, boundary)
  expect(save).not.toHaveBeenCalled()
  fixture.select()
  expect(fixture.store.loadAll()[0]).toMatchObject({
    version: 10,
    captureBaseline: baseline,
    issuedCaptureBoundaries: [boundary]
  })
  expect(
    makeDelegatedRelay(fixture.store, {
      enableDestinationOutputRetention: true
    }).inspectDestination(request(), context()).captureBaseline
  ).toEqual(baseline)
})
it('refuses selection of an unissued boundary without corrupting the durable record', () => {
  const fixture = setup()
  fixture.adapter.retainCaptureBoundary(identity, boundary)
  const other = { ...boundary, delivery: { ...boundary.delivery, deliveryToken: 'unissued' } }
  fixture.inspect.mockReturnValue(other)
  expect(() => fixture.select({ ...baseline, boundary: other })).toThrow('selection_unavailable')
  expect(fixture.store.loadAll()[0].captureBaseline).toBeUndefined()
  expect(() =>
    makeDelegatedRelay(fixture.store, { enableDestinationOutputRetention: true })
  ).not.toThrow()
})

it('fences uncertain boundary writes and never acknowledges them from memory', () => {
  const fixture = setup()
  vi.spyOn(fixture.store, 'save').mockImplementationOnce(() => {
    throw new Error('uncertain write')
  })
  expect(() => fixture.adapter.retainCaptureBoundary(identity, boundary)).toThrow('uncertain write')
  expect(() => fixture.adapter.retainCaptureBoundary(identity, boundary)).toThrow(
    'boundary_unavailable'
  )
  expect(() => fixture.select()).toThrow('unavailable')
})

it('bounds issued evidence without evicting prior boundaries', () => {
  const fixture = setup()
  for (let index = 0; index < 32; index++) {
    fixture.adapter.retainCaptureBoundary(identity, {
      ...boundary,
      delivery: { ...boundary.delivery, deliveryToken: `delivery-${index}` }
    })
  }
  expect(() => fixture.adapter.retainCaptureBoundary(identity, boundary)).toThrow(
    'boundary_capacity'
  )
  expect(fixture.store.loadAll()[0].issuedCaptureBoundaries).toHaveLength(32)
})
it('preserves a renamed boundary journal after an uncertain flush without granting selection', () => {
  const fixture = setup()
  const save = fixture.store.save.bind(fixture.store)
  vi.spyOn(fixture.store, 'save').mockImplementationOnce((record) => {
    save(record)
    throw new Error('flush uncertain')
  })
  expect(() => fixture.adapter.retainCaptureBoundary(identity, boundary)).toThrow('flush uncertain')
  expect(() => fixture.adapter.retainCaptureBoundary(identity, boundary)).toThrow(
    'boundary_unavailable'
  )
  const reopened = makeDelegatedRelay(fixture.store, { enableDestinationOutputRetention: true })
  expect(reopened.inspectDestination(request(), context()).captureBaseline).toBeUndefined()
  expect(fixture.store.loadAll()[0].issuedCaptureBoundaries).toEqual([boundary])
})

it.each(['old-version', 'empty', 'future', 'duplicate', 'wrong-identity', 'unattested-baseline'])(
  'rejects malformed issued capture journal: %s',
  (mode) => {
    const fixture = setup()
    fixture.adapter.retainCaptureBoundary(identity, boundary)
    const record = structuredClone(fixture.store.loadAll()[0]) as unknown as Record<string, unknown>
    if (mode === 'old-version') {
      record.version = 9
    }
    if (mode === 'empty') {
      record.issuedCaptureBoundaries = []
    }
    if (mode === 'future') {
      record.issuedCaptureBoundaries = [{ ...boundary, throughSeq: 2 }]
    }
    if (mode === 'duplicate') {
      record.issuedCaptureBoundaries = [boundary, boundary]
    }
    if (mode === 'wrong-identity') {
      record.issuedCaptureBoundaries = [
        { ...boundary, identity: { ...identity, incarnationId: 'other' } }
      ]
    }
    if (mode === 'unattested-baseline') {
      record.captureBaseline = {
        ...baseline,
        boundary: { ...boundary, delivery: { ...boundary.delivery, deliveryToken: 'other' } }
      }
    }
    vi.spyOn(fixture.store, 'loadAll').mockReturnValue([
      record as unknown as RelayPtyOwnershipTransferDurableRecord
    ])
    expect(() =>
      makeDelegatedRelay(fixture.store, { enableDestinationOutputRetention: true })
    ).toThrow()
  }
)

it('durably binds the exact snapshot without changing ACK, replay or source output', () => {
  const fixture = setup()
  const before = fixture.store.loadAll()[0]
  const selected = fixture.select()
  expect(Object.isFrozen(selected)).toBe(true)
  expect(selected).toEqual(baseline)
  const saved = fixture.store.loadAll()[0]
  expect(saved).toMatchObject({ version: 9, captureJournalVersion: 4, captureBaseline: baseline })
  expect(saved.history).toEqual(before.history)
  expect(saved.replayStartSeq).toBe(before.replayStartSeq)
  expect(saved.sourceOutputEndSeq).toBe(1)
  const save = vi.spyOn(fixture.store, 'save')
  expect(fixture.select()).toEqual(selected)
  expect(save).not.toHaveBeenCalled()
  const reopened = makeDelegatedRelay(fixture.store, { enableDestinationOutputRetention: true })
  const status = reopened.inspectDestination(request(), context())
  expect(status.captureBaseline).toEqual(baseline)
  expect(status.captureBaseline).not.toBe(selected)
  expect(reopened.selectCaptureBaseline(identity, baseline, () => boundary)).toEqual(selected)
  reopened.claimDestination(request(), context())
  expect(reopened.inspectDestination(request(), context())).toMatchObject({
    destinationAcknowledgedSeq: 0
  })
  expect(fixture.store.loadAll()[0]).toMatchObject({
    version: 9,
    captureJournalVersion: 4,
    captureBaseline: baseline
  })
})

it('does not reveal a selected baseline without authenticated destination proof', () => {
  const fixture = setup()
  fixture.select()
  const unauthenticated = context()
  unauthenticated.sessionIdentity = { ...unauthenticated.sessionIdentity!, authenticated: false }
  expect(() => fixture.adapter.inspectDestination(request(), unauthenticated)).toThrow(
    'unauthorized'
  )
  expect(() =>
    fixture.adapter.inspectDestination({ ...request(), credential: '0'.repeat(64) }, context())
  ).toThrow('unauthorized')
  expect(() =>
    fixture.adapter.inspectDestination(request(), { ...context(), isStale: () => true })
  ).toThrow('unauthorized')
})

it('preserves all later output through selection and journal reopen', () => {
  const fixture = setup()
  fixture.select()
  fixture.adapter.observeOutput(identity.terminalId, 'after')
  const reopened = makeDelegatedRelay(fixture.store, { enableDestinationOutputRetention: true })
  expect(reopened.replay({ version: 1, ...identity, afterSeq: 1 }).frames).toMatchObject([
    { seq: 2, data: 'after' }
  ])
  expect(fixture.store.loadAll()[0]).toMatchObject({
    version: 9,
    captureBaseline: baseline,
    sourceOutputEndSeq: 2,
    replayStartSeq: 1
  })
})

it.each([5, 6, 7, 8] as const)(
  'preserves capture alongside mutation journal version %s on restart',
  (version) => {
    const fixture = setup()
    fixture.select()
    fixture.adapter.claimDestination(request(), context())
    const record: RelayPtyOwnershipTransferDurableRecord = {
      ...fixture.store.loadAll()[0],
      captureJournalVersion: version,
      phase: 'committed',
      commitReceipt: {
        bridgeId: identity.bridgeId,
        receiptId: 'captured-commit',
        acceptedSourceEndSeq: 1,
        committedAt: '2026-09-06T00:00:00.000Z'
      },
      ...(version >= 6
        ? {
            destinationInputJournal: true as const,
            destinationInputs: [
              { inputId: 'input', data: 'pwd\n', outcome: 'unverifiable' as const }
            ]
          }
        : {}),
      ...(version >= 7 ? { destinationInputEpoch: 2 } : {}),
      ...(version === 8
        ? {
            destinationControlJournal: true as const,
            destinationControls: [
              {
                controlId: 'resize',
                serializedControl: '{"kind":"resize","cols":80,"rows":24}',
                outcome: 'unverifiable' as const
              }
            ]
          }
        : {})
    }
    fixture.store.save(record)
    const reopened = makeDelegatedRelay(fixture.store, { enableDestinationOutputRetention: true })
    reopened.claimDestination(request(2), context())
    const saved = fixture.store.loadAll()[0]
    expect(saved).toMatchObject({
      version: 9,
      captureJournalVersion: version,
      captureBaseline: baseline
    })
    expect(saved.destinationInputs).toEqual(record.destinationInputs)
    expect(saved.destinationInputEpoch).toEqual(record.destinationInputEpoch)
    expect(saved.destinationControls).toEqual(record.destinationControls)
  }
)

it('refuses conflicting snapshot digests for the same capture', () => {
  const fixture = setup()
  fixture.select()
  expect(() => fixture.select({ ...baseline, modelSha256: 'b'.repeat(64) })).toThrow('conflict')
  expect(fixture.store.loadAll()[0].captureBaseline).toEqual(baseline)
})

it.each(['expired', 'changed', 'advanced', 'claimed', 'aborted'])(
  'refuses %s capture authority',
  (mode) => {
    const fixture = setup()
    if (mode === 'expired') {
      fixture.inspect.mockReturnValue(null)
    } else if (mode === 'changed') {
      fixture.inspect.mockReturnValue({
        ...boundary,
        delivery: { ...boundary.delivery, deliveryToken: 'other' }
      })
    } else if (mode === 'advanced') {
      fixture.adapter.observeOutput(identity.terminalId, 'late')
    } else if (mode === 'claimed') {
      fixture.adapter.claimDestination(request(), context())
    } else {
      fixture.adapter.abort({ version: 1, ...identity })
    }
    expect(() => fixture.select()).toThrow('unavailable')
    expect(fixture.store.loadAll()[0].captureBaseline).toBeUndefined()
  }
)

it.each(['before', 'after'])(
  'fences an uncertain %s-write selection until disk recovery',
  (mode) => {
    const fixture = setup()
    const save = fixture.store.save.bind(fixture.store)
    vi.spyOn(fixture.store, 'save').mockImplementation((record) => {
      if (mode === 'after') {
        save(record)
      }
      throw new Error('uncertain write')
    })
    expect(() => fixture.select()).toThrow('uncertain write')
    expect(() => fixture.select()).toThrow('unavailable')
    expect(fixture.adapter.inspectPreparedCaptureCursor(identity)).toBeNull()
    vi.restoreAllMocks()
    const reopened = makeDelegatedRelay(fixture.store, { enableDestinationOutputRetention: true })
    expect(reopened.selectCaptureBaseline(identity, baseline, () => boundary)).toEqual(baseline)
  }
)

it.each([
  { version: 4 },
  { captureBaseline: undefined },
  { captureJournalVersion: undefined },
  { captureJournalVersion: 1 },
  { captureJournalVersion: '4' },
  { captureBaseline: { ...baseline, modelSha256: 'invalid' } },
  { captureBaseline: { ...baseline, boundary: { ...boundary, throughSeq: 2 } } },
  {
    captureBaseline: {
      ...baseline,
      boundary: { ...boundary, identity: { ...identity, ownerLease: 'other' } }
    }
  }
])('rejects corrupted or downgraded capture journals: %j', (patch) => {
  const fixture = setup()
  fixture.select()
  const saved = fixture.store.loadAll()[0]
  fixture.store.save({ ...saved, ...patch } as RelayPtyOwnershipTransferDurableRecord)
  expect(() =>
    makeDelegatedRelay(fixture.store, { enableDestinationOutputRetention: true })
  ).toThrow()
})
