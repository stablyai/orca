import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { RelayPtyOwnershipTransferFileStore } from './relay-pty-ownership-transfer-file-store'
import {
  identity,
  preparation,
  source,
  context,
  makeDelegatedRelay
} from './relay-pty-ownership-transfer-delegation-test-fixture'
import { parsePtyOwnershipCaptureBaseline } from '../shared/pty-ownership-capture-baseline'
import { beginRelayPtySuccessorCaptureBoundary } from './relay-pty-successor-capture-boundary'

const directories: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})
const baseline = parsePtyOwnershipCaptureBaseline(
  {
    version: 1,
    modelSha256: 'a'.repeat(64),
    boundary: {
      version: 1,
      identity,
      throughSeq: 0,
      delivery: {
        id: identity.terminalId,
        ptyIncarnation: identity.incarnationId,
        providerGeneration: 1,
        clientGeneration: 1,
        ownerGeneration: identity.sourceOwnerGeneration,
        deliveryToken: 'original',
        state: 'active',
        windowSu: 256,
        receivedEndSu: 0,
        sentEndSu: 0,
        creditedEndSu: 0,
        exitPublished: false,
        generationClosed: false
      }
    }
  },
  identity
)

function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'orca-successor-cursor-'))
  directories.push(directory)
  const store = new RelayPtyOwnershipTransferFileStore(directory)
  const resolveSource = vi.fn((): typeof source | null => source)
  const resolveTerminalIncarnation = vi.fn((): string | null => identity.incarnationId)
  const hasPendingSourceOutput = vi.fn(() => false)
  const options = {
    enableDestinationOutputRetention: true,
    resolveSource,
    resolveTerminalIncarnation,
    hasPendingSourceOutput
  }
  const relay = makeDelegatedRelay(store, options)
  relay.prepare(preparation)
  relay.retainCaptureBoundary(identity, baseline.boundary)
  relay.selectCaptureBaseline(identity, baseline, () => baseline.boundary)
  resolveSource.mockReturnValue(null)
  return { relay, store, options, resolveTerminalIncarnation, hasPendingSourceOutput }
}

it('retains the existing ingress fence for successor inspection without rewriting capture evidence', () => {
  const f = setup()
  const lease = { isCurrent: () => true, isDrained: vi.fn(() => false), release: vi.fn() }
  const authorizes = vi.fn(() => true)
  const inspect = vi.fn(() => baseline.boundary.delivery)
  const request = context()
  const save = vi.spyOn(f.store, 'save')
  const begin = vi.fn(() => lease)
  const capture = beginRelayPtySuccessorCaptureBoundary(
    identity,
    baseline,
    identity.sourceOwnerGeneration + 1,
    request,
    {
      handler: { beginOwnershipTransferCaptureIngress: begin },
      transfer: f.relay,
      source: {
        authorizesResumedTransferAtGeneration: authorizes,
        inspectSuccessorDrainedDelivery: inspect
      }
    }
  )
  expect(capture.inspect()).toBeNull()
  expect(inspect).not.toHaveBeenCalled()
  lease.isDrained.mockReturnValue(true)
  expect(capture.inspect()).toEqual(baseline.boundary)
  expect(authorizes).toHaveBeenLastCalledWith(
    identity.ownerLease,
    identity.sourceOwnerGeneration + 1,
    request.clientId
  )
  expect(inspect).toHaveBeenLastCalledWith(identity, request.clientId, baseline.boundary.delivery)
  expect(save).not.toHaveBeenCalled()
  authorizes.mockReturnValue(false)
  expect(capture.inspect()).toBeNull()
  expect(lease.release).toHaveBeenCalledOnce()
  capture.release()
  expect(lease.release).toHaveBeenCalledOnce()
})

it.each([0, identity.sourceOwnerGeneration, Number.NaN])(
  'rejects invalid successor generation %s before taking ingress',
  (generation) => {
    const f = setup()
    const begin = vi.fn()
    expect(() =>
      beginRelayPtySuccessorCaptureBoundary(identity, baseline, generation, context(), {
        handler: { beginOwnershipTransferCaptureIngress: begin },
        transfer: f.relay,
        source: {
          authorizesResumedTransferAtGeneration: vi.fn(() => true),
          inspectSuccessorDrainedDelivery: vi.fn()
        }
      })
    ).toThrow('successor_generation_invalid')
    expect(begin).not.toHaveBeenCalled()
  }
)

it('reads the selected exact-end baseline without incumbent authority, including after reopen', () => {
  const f = setup()
  const save = vi.spyOn(f.store, 'save')
  expect(f.relay.inspectPreparedCaptureCursor(identity)).toBeNull()
  expect(f.relay.inspectSuccessorCaptureEvidence(identity, baseline)).toMatchObject({
    throughSeq: 0
  })
  expect(
    makeDelegatedRelay(f.store, f.options).inspectSuccessorCaptureEvidence(identity, baseline)
  ).toMatchObject({ throughSeq: 0 })
  expect(save).not.toHaveBeenCalled()
})

it('refuses advanced journal text without explicit raw-delivery mapping, including after reopen', () => {
  const f = setup()
  f.relay.observeOutput(identity.terminalId, 'one🙂')
  f.relay.observeOutput(identity.terminalId, 'two')
  const before = f.store.loadAll()
  expect(f.relay.inspectSuccessorCaptureEvidence(identity, baseline)).toBeNull()
  expect(
    makeDelegatedRelay(f.store, f.options).inspectSuccessorCaptureEvidence(identity, baseline)
  ).toEqual(f.relay.inspectSuccessorCaptureEvidence(identity, baseline))
  expect(f.store.loadAll()).toEqual(before)
})

it.each(['model', 'delivery', 'identity', 'incarnation', 'pending', 'missing-probe', 'aborted'])(
  'refuses unavailable or changed successor journal evidence: %s',
  (change) => {
    const f = setup()
    let candidate: unknown = baseline
    if (change === 'model') {
      candidate = { ...baseline, modelSha256: 'b'.repeat(64) }
    }
    if (change === 'delivery') {
      candidate = {
        ...baseline,
        boundary: {
          ...baseline.boundary,
          delivery: { ...baseline.boundary.delivery, deliveryToken: 'other' }
        }
      }
    }
    if (change === 'incarnation') {
      f.resolveTerminalIncarnation.mockReturnValue('replacement')
    }
    if (change === 'pending') {
      f.hasPendingSourceOutput.mockReturnValue(true)
    }
    if (change === 'aborted') {
      f.options.resolveSource.mockReturnValue(source)
      f.relay.abort({ version: 1, ...identity })
    }
    const relay =
      change === 'missing-probe'
        ? makeDelegatedRelay(f.store, { ...f.options, hasPendingSourceOutput: undefined })
        : f.relay
    expect(
      relay.inspectSuccessorCaptureEvidence(
        change === 'identity' ? { ...identity, ownerLease: 'other' } : identity,
        candidate
      )
    ).toBeNull()
  }
)
