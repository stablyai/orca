import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  identity,
  preparation,
  source,
  context,
  request
} from './relay-pty-ownership-transfer-delegation-test-fixture'
import { RelayPtyOwnershipTransferFileStore } from './relay-pty-ownership-transfer-file-store'
import { newRelayPtyOwnershipTransferAdapterState } from './relay-pty-ownership-transfer-adapter-state'
import { prepareRelayPtyOwnershipTransfer } from './relay-pty-ownership-transfer-adapter-operations'
import { observeRelayPtyOwnershipTransferOutput } from './relay-pty-ownership-transfer-output-observation'
import { retainRelayPtyOwnershipCaptureBoundary } from './relay-pty-ownership-issued-capture-boundary'
import { recoverRelayPtyOwnershipCaptureSelection } from './relay-pty-ownership-capture-selection-recovery'
import { parsePtyOwnershipCaptureBoundary } from '../shared/pty-ownership-capture-boundary'

let directory: string
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-selection-recovery-'))
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
      ownerGeneration: identity.sourceOwnerGeneration,
      providerGeneration: 1,
      clientGeneration: 1,
      deliveryToken: 'old-delivery',
      state: 'active',
      windowSu: 1024,
      receivedEndSu: 3,
      sentEndSu: 3,
      creditedEndSu: 3,
      generationClosed: false,
      exitPublished: false
    }
  },
  identity
)
const baseline = { version: 1, boundary, modelSha256: 'a'.repeat(64) }
function setup() {
  const store = new RelayPtyOwnershipTransferFileStore(directory)
  const options = {
    store,
    enableDestinationDelegationPreparation: true,
    enableDestinationDelegationClaims: true,
    enableDestinationOutputRetention: true,
    resolveSource: () => source,
    resolveTerminalIncarnation: () => identity.incarnationId,
    authorizeRequest: () => false,
    setInputFenced: vi.fn(),
    writeDestinationInput: vi.fn(),
    publishDestinationOutput: vi.fn()
  }
  const state = newRelayPtyOwnershipTransferAdapterState({ options })
  prepareRelayPtyOwnershipTransfer(state, preparation)
  observeRelayPtyOwnershipTransferOutput(state, identity.terminalId, 'one')
  retainRelayPtyOwnershipCaptureBoundary(state, identity, boundary)
  observeRelayPtyOwnershipTransferOutput(state, identity.terminalId, 'later')
  return {
    state,
    options,
    store,
    recover: () =>
      recoverRelayPtyOwnershipCaptureSelection(state, request(), baseline, context(9, 8))
  }
}
it('selects the historical boundary on a new transport without acknowledging or dropping later output', () => {
  const f = setup()
  const before = f.store.loadAll()[0]
  const reopened = newRelayPtyOwnershipTransferAdapterState({ options: f.options })
  expect(
    recoverRelayPtyOwnershipCaptureSelection(reopened, request(), baseline, context(9, 8))
  ).toEqual(baseline)
  const after = f.store.loadAll()[0]
  expect(after.captureBaseline).toEqual(baseline)
  expect(after.history).toEqual(before.history)
  expect(after.sourceOutputEndSeq).toBe(2)
  expect(after.replayStartSeq).toBe(before.replayStartSeq)
  expect(after.destinationClaim).toBeUndefined()
  expect(after.phase).toBe('prepared')
  expect(f.options.writeDestinationInput).not.toHaveBeenCalled()
})
it('allows an exact retry and refuses a changed model digest', () => {
  const f = setup()
  f.recover()
  const save = vi.spyOn(f.store, 'save')
  expect(f.recover()).toEqual(baseline)
  expect(save).not.toHaveBeenCalled()
  expect(() =>
    recoverRelayPtyOwnershipCaptureSelection(
      f.state,
      request(),
      { ...baseline, modelSha256: 'b'.repeat(64) },
      context()
    )
  ).toThrow('selection_conflict')
})
it.each(['credential', 'unauthenticated', 'stale', 'incarnation'])(
  'refuses invalid destination proof: %s',
  (mode) => {
    const f = setup()
    const proof = {
      ...request(),
      ...(mode === 'credential' ? { credential: '0'.repeat(64) } : {}),
      ...(mode === 'incarnation' ? { incarnationId: 'other' } : {})
    }
    const caller = context()
    if (mode === 'unauthenticated') {
      caller.sessionIdentity = { ...caller.sessionIdentity!, authenticated: false }
    }
    if (mode === 'stale') {
      caller.isStale = () => true
    }
    expect(() =>
      recoverRelayPtyOwnershipCaptureSelection(f.state, proof, baseline, caller)
    ).toThrow()
    expect(f.store.loadAll()[0].captureBaseline).toBeUndefined()
  }
)
it.each([
  'unattested',
  'changed-boundary',
  'missing-suffix',
  'truncated',
  'unverifiable',
  'claimed'
])('preserves evidence and refuses incomplete recovery: %s', (mode) => {
  const f = setup()
  const transfer = f.state.transfers.get(identity.bridgeId)!
  if (mode === 'unattested') {
    transfer.issuedCaptureBoundaries = undefined
  }
  if (mode === 'changed-boundary') {
    transfer.issuedCaptureBoundaries = [
      { ...boundary, delivery: { ...boundary.delivery, deliveryToken: 'replacement' } }
    ]
  }
  if (mode === 'missing-suffix') {
    f.state.histories.get(identity.terminalId)!.frames.pop()
  }
  if (mode === 'truncated') {
    const frames = f.state.histories.get(identity.terminalId)!.frames
    frames[1] = { ...frames[1], truncated: true }
  }
  if (mode === 'unverifiable') {
    f.options.resolveTerminalIncarnation = () => 'other'
  }
  if (mode === 'claimed') {
    transfer.destinationClaim = { generation: 1, claimId: 'claim' }
  }
  expect(f.recover).toThrow()
  expect(f.store.loadAll()[0].captureBaseline).toBeUndefined()
})
it.each([false, true])('fences uncertain persistence (after rename=%s)', (renamed) => {
  const f = setup()
  const save = f.store.save.bind(f.store)
  vi.spyOn(f.store, 'save').mockImplementationOnce((record) => {
    if (renamed) {
      save(record)
    }
    throw new Error('uncertain write')
  })
  expect(f.recover).toThrow('uncertain write')
  expect(f.recover).toThrow('claim_unavailable')
  expect(f.store.loadAll()[0].captureBaseline).toEqual(renamed ? baseline : undefined)
})
