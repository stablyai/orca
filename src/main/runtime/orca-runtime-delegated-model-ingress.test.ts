import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createStore, testState } from '../persistence-test-harness'
import { OrcaRuntimeService } from './orca-runtime'
import { HeadlessEmulator } from '../daemon/headless-emulator'
import { drainOrcadDelegatedOutput } from '../orcad/orcad-delegated-output-drain'
import {
  identity,
  preparation,
  request
} from '../../relay/relay-pty-ownership-transfer-delegation-test-fixture'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))
beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'orca-model-ingress-'))
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(testState.dir, { recursive: true, force: true })
})
const binding = preparation.surfacePublication.surfaceBinding
const frame = { seq: 1, data: 'one copy\n' }
function runtimeFor(store: ReturnType<typeof createStore>) {
  const runtime = new OrcaRuntimeService(store, undefined, {
    runtimeId: identity.destinationRuntimeId
  })
  runtime.installPtyOwnershipTransferDestinationOutputBridge()
  runtime.registerPty(binding.ptyId, binding.workspaceKey, null, {
    tabId: binding.tabId,
    leafId: binding.leafId,
    incarnationId: identity.incarnationId
  })
  return runtime
}
function setup(baseEndSeq = 0, withInitialModel = false) {
  const store = createStore()
  const runtime = runtimeFor(store)
  const registry = runtime.getPtyOwnershipTransferDestinationRegistry()!
  const prepared = registry.prepareDelegated(
    {
      ...identity,
      version: 1,
      phase: 'prepared',
      sourceOutputEndSeq: baseEndSeq,
      replayStartSeq: baseEndSeq + 1,
      surfacePublication: preparation.surfacePublication
    },
    {
      version: 1,
      proof: request(),
      endpoint: '/incumbent.sock',
      incumbentVersion: 'test',
      endpointCredential: 'test'
    }
  )
  if (withInitialModel) {
    prepared.outputOutbox.recordInitialModelSnapshot(identity, {
      ...initialModel,
      throughSeq: baseEndSeq
    })
  }
  prepared.adapter.commit({
    bridgeId: identity.bridgeId,
    receiptId: 'receipt',
    acceptedSourceEndSeq: baseEndSeq,
    committedAt: '2026-09-06T00:00:00.000Z'
  })
  prepared.adapter.publish()
  prepared.outputOutbox.enqueue(identity, { ...frame, seq: baseEndSeq + 1 })
  return { runtime, store, ...prepared }
}

it('initializes an empty model without inventing a snapshot and refuses uncheckpointed output', async () => {
  const fixture = setup()
  const restore = vi.spyOn(fixture.runtime, 'restoreDelegatedPtyOwnershipModel')
  await fixture.runtime.initializeDelegatedPtyOwnershipModel(identity)
  expect(restore).not.toHaveBeenCalled()
  vi.spyOn(fixture.runtime, 'getPtyOutputSequence').mockReturnValue(1)
  await expect(fixture.runtime.initializeDelegatedPtyOwnershipModel(identity)).rejects.toThrow(
    'initial_baseline_unavailable'
  )
})

const initialModel = {
  version: 1,
  identity,
  throughSeq: 0,
  modelSequenceEnd: 100,
  modelData: 'retained baseline\r\n',
  cols: 80,
  rows: 24,
  restoreMetadata: {
    version: 1 as const,
    kittyKeyboardFlags: 5,
    cwd: '/srv/retained',
    lastTitle: 'retained-title',
    pendingEscapeTailAnsi: ''
  }
}

const clearClaim = { generation: 1, claimId: 'clear-owner' }
async function readyClear() {
  const f = setup(0, true)
  await f.runtime.initializeDelegatedPtyOwnershipModel(identity)
  await f.runtime.prepareDelegatedPtyModelFrame(identity, frame)
  f.outputOutbox.acknowledge(identity, 1)
  f.adapter.bindDelegatedExecution(clearClaim)
  return f
}

it('clears the live model durably once, preserving sequence and retry identity after later output', async () => {
  const f = await readyClear()
  const before = f.runtime.getPtyOutputSequence(binding.ptyId)
  const clear = vi.spyOn(HeadlessEmulator.prototype, 'clearScrollback')
  await f.runtime.clearPublishedDelegatedPtyModel(identity, 'clear-1', clearClaim)
  expect(clear).toHaveBeenCalledTimes(1)
  const snapshot = await f.runtime.serializePublishedDelegatedPtyModel(identity)
  expect(snapshot?.seq).toBe(before)
  expect(snapshot?.data).not.toContain('retained baseline')
  expect(f.outputOutbox.loadModelClear(identity)?.model.modelData).not.toContain(
    'retained baseline'
  )
  const next = { seq: 2, data: 'after clear' }
  f.outputOutbox.enqueue(identity, next)
  await f.runtime.prepareDelegatedPtyModelFrame(identity, next)
  f.outputOutbox.acknowledge(identity, 2)
  await f.runtime.clearPublishedDelegatedPtyModel(identity, 'clear-1', clearClaim)
  expect(clear).toHaveBeenCalledTimes(1)
  expect((await f.runtime.serializePublishedDelegatedPtyModel(identity))?.data).toContain(
    'after clear'
  )
})

it.each(['before', 'after'])(
  'retries uncertain %s-write clear without a second emulator mutation',
  async (boundary) => {
    const f = await readyClear()
    const clear = vi.spyOn(HeadlessEmulator.prototype, 'clearScrollback')
    const persist = f.outputOutbox.recordModelClear.bind(f.outputOutbox)
    vi.spyOn(f.outputOutbox, 'recordModelClear').mockImplementationOnce((...args) => {
      if (boundary === 'after') {
        persist(...args)
      }
      throw new Error('uncertain clear')
    })
    await expect(
      f.runtime.clearPublishedDelegatedPtyModel(identity, 'clear-1', clearClaim)
    ).rejects.toThrow('uncertain clear')
    await expect(f.runtime.serializePublishedDelegatedPtyModel(identity)).resolves.toBeNull()
    const next = { seq: 2, data: 'retained next' }
    f.outputOutbox.enqueue(identity, next)
    await expect(f.runtime.prepareDelegatedPtyModelFrame(identity, next)).rejects.toThrow(
      'ingress_unavailable'
    )
    await expect(
      f.runtime.clearPublishedDelegatedPtyModel(identity, 'other', clearClaim)
    ).rejects.toThrow('clear_unavailable')
    await f.runtime.clearPublishedDelegatedPtyModel(identity, 'clear-1', clearClaim)
    expect(clear).toHaveBeenCalledTimes(1)
    await f.runtime.prepareDelegatedPtyModelFrame(identity, next)
    f.outputOutbox.acknowledge(identity, 2)
    expect((await f.runtime.serializePublishedDelegatedPtyModel(identity))?.data).toContain(
      'retained next'
    )
  }
)

it('holds incoming model frames and snapshots until clear is durable', async () => {
  const f = await readyClear()
  let release!: () => void
  const wait = new Promise<void>((resolve) => {
    release = resolve
  })
  const original = HeadlessEmulator.prototype.clearScrollback
  const clear = vi
    .spyOn(HeadlessEmulator.prototype, 'clearScrollback')
    .mockImplementation(function (this: HeadlessEmulator) {
      original.call(this)
      return wait as never
    })
  const clearing = f.runtime.clearPublishedDelegatedPtyModel(identity, 'clear-1', clearClaim)
  await vi.waitFor(() => expect(clear).toHaveBeenCalledTimes(1))
  await expect(f.runtime.serializePublishedDelegatedPtyModel(identity)).resolves.toBeNull()
  const next = { seq: 2, data: 'after concurrent clear' }
  f.outputOutbox.enqueue(identity, next)
  const admission = vi.spyOn(f.runtime, 'acceptPtyDataBounded')
  const preparing = f.runtime.prepareDelegatedPtyModelFrame(identity, next)
  expect(admission).not.toHaveBeenCalled()
  release()
  await clearing
  await preparing
  f.outputOutbox.acknowledge(identity, 2)
  expect(admission).toHaveBeenCalledTimes(1)
  expect((await f.runtime.serializePublishedDelegatedPtyModel(identity))?.data).toContain(
    'after concurrent clear'
  )
})

it('refuses stale clear authority before touching the emulator', async () => {
  const f = await readyClear()
  const clear = vi.spyOn(HeadlessEmulator.prototype, 'clearScrollback')
  await expect(
    f.runtime.clearPublishedDelegatedPtyModel(identity, 'clear-1', {
      generation: 2,
      claimId: 'other'
    })
  ).rejects.toThrow('authority_changed')
  expect(clear).not.toHaveBeenCalled()
  expect(f.outputOutbox.loadModelClear(identity)).toBeNull()
})

it('refuses publication of a nonzero replay baseline without committed model evidence', () => {
  expect(() => setup(20)).toThrow('does not prove the exact committed transfer')
})

it.each([0, 20])(
  'restores baseline %s and metadata before new output, preferring later snapshots on restart',
  async (baseEndSeq) => {
    const fixture = setup(baseEndSeq, true)
    const output = { ...frame, seq: baseEndSeq + 1 }
    const ref =
      fixture.store.getWorkspaceSession().terminalLayoutsByTabId[binding.tabId]
        ?.scrollbackRefsByLeafId?.[binding.leafId]
    expect(ref && fixture.store.readTerminalScrollbackSnapshot(ref)).toBe(initialModel.modelData)
    await expect(fixture.runtime.prepareDelegatedPtyModelFrame(identity, output)).rejects.toThrow(
      'restore_required'
    )
    await fixture.runtime.initializeDelegatedPtyOwnershipModel(identity)
    expect(fixture.runtime.getPtyOutputSequence(binding.ptyId)).toBe(100)
    const baseline = await fixture.runtime.serializeMainTerminalBuffer(binding.ptyId)
    expect(baseline).toMatchObject({
      seq: 100,
      cols: 80,
      rows: 24,
      kittyKeyboardFlags: 5,
      cwd: '/srv/retained',
      lastTitle: 'retained-title'
    })
    expect(baseline?.data).toContain('retained baseline')
    await fixture.runtime.prepareDelegatedPtyModelFrame(identity, output)
    const saved = fixture.outputOutbox.loadModelSnapshot(identity)!
    expect(saved.checkpoint.modelSequenceEnd).toBe(100 + frame.data.length)

    const runtime = runtimeFor(fixture.store)
    const recovered = runtime
      .getPtyOwnershipTransferDestinationRegistry()!
      .recoverPersistedDelegatedDestinations()[0]
    await runtime.initializeDelegatedPtyOwnershipModel(identity)
    const accept = vi.spyOn(runtime, 'acceptPtyDataBounded')
    await runtime.prepareDelegatedPtyModelFrame(identity, output)
    expect(accept).not.toHaveBeenCalled()
    expect(runtime.getPtyOutputSequence(binding.ptyId)).toBe(saved.checkpoint.modelSequenceEnd)
    const restored = await runtime.serializeMainTerminalBuffer(binding.ptyId)
    expect(restored?.data.match(/retained baseline/g)).toHaveLength(1)
    expect(restored?.data.match(/one copy/g)).toHaveLength(1)
    recovered.adapter.acceptPostCommitOutput(output)
    recovered.outbox.acknowledge(identity, baseEndSeq + 1)
    const next = { seq: baseEndSeq + 2, data: 'next\n' }
    recovered.outbox.enqueue(identity, next)
    await runtime.prepareDelegatedPtyModelFrame(identity, next)
    expect(accept).toHaveBeenCalledOnce()
    expect(runtime.getPtyOutputSequence(binding.ptyId)).toBe(
      saved.checkpoint.modelSequenceEnd + next.data.length
    )
  }
)

it.each([0, 20])(
  'recovers baseline %s from disk before any new frame has been applied',
  async (baseEndSeq) => {
    const fixture = setup(baseEndSeq, true)
    fixture.store.checkpointPtyOwnershipTransferTerminalModel({
      identity,
      surfaceBinding: binding,
      publicationReceipt: fixture.adapter.snapshot().publicationReceipt!,
      modelData: 'stale projection'
    })
    const runtime = runtimeFor(fixture.store)
    runtime.getPtyOwnershipTransferDestinationRegistry()!.recoverPersistedDelegatedDestinations()
    const ref =
      fixture.store.getWorkspaceSession().terminalLayoutsByTabId[binding.tabId]
        ?.scrollbackRefsByLeafId?.[binding.leafId]
    expect(ref && fixture.store.readTerminalScrollbackSnapshot(ref)).toBe(initialModel.modelData)
    await runtime.initializeDelegatedPtyOwnershipModel(identity)
    expect(runtime.getPtyOutputSequence(binding.ptyId)).toBe(100)
    await runtime.prepareDelegatedPtyModelFrame(identity, { ...frame, seq: baseEndSeq + 1 })
    expect(runtime.getPtyOutputSequence(binding.ptyId)).toBe(100 + frame.data.length)
  }
)

it('does not restore a baseline onto a replaced terminal incarnation', async () => {
  const fixture = setup()
  fixture.outputOutbox.recordInitialModelSnapshot(identity, initialModel)
  fixture.runtime.registerPty(binding.ptyId, binding.workspaceKey, null, {
    tabId: binding.tabId,
    leafId: binding.leafId,
    incarnationId: 'replacement'
  })
  await expect(fixture.runtime.initializeDelegatedPtyOwnershipModel(identity)).rejects.toThrow(
    'route_mismatch'
  )
  expect(fixture.runtime.getPtyOutputSequence(binding.ptyId)).toBe(0)
})

it('writes through bounded model admission and retries a failed journal without rendering twice', async () => {
  const fixture = setup()
  const accept = vi.spyOn(fixture.runtime, 'acceptPtyDataBounded')
  vi.spyOn(fixture.outputOutbox, 'recordModelSnapshot').mockImplementationOnce(() => {
    throw new Error('disk failed')
  })
  await expect(fixture.runtime.prepareDelegatedPtyModelFrame(identity, frame)).rejects.toThrow(
    'disk failed'
  )
  expect(fixture.runtime.getPtyOutputSequence(binding.ptyId)).toBe(frame.data.length)
  await fixture.runtime.prepareDelegatedPtyModelFrame(identity, frame)
  await fixture.runtime.prepareDelegatedPtyModelFrame(identity, frame)
  expect(accept).toHaveBeenCalledOnce()
  expect(fixture.outputOutbox.loadModelSnapshot(identity)?.checkpoint.data).toBe(frame.data)
  fixture.adapter.acceptPostCommitOutput(frame)
  fixture.outputOutbox.acknowledge(identity, frame.seq)
  expect(fixture.outputOutbox.load(identity)?.pendingFrames).toEqual([])
})

it('requires restore on restart, then skips the saved frame and ingests only new bytes', async () => {
  const fixture = setup()
  await fixture.runtime.prepareDelegatedPtyModelFrame(identity, frame)
  const runtime = runtimeFor(fixture.store)
  const recovered = runtime
    .getPtyOwnershipTransferDestinationRegistry()!
    .recoverPersistedDelegatedDestinations()[0]
  await expect(runtime.prepareDelegatedPtyModelFrame(identity, frame)).rejects.toThrow(
    'restore_required'
  )
  await runtime.initializeDelegatedPtyOwnershipModel(identity)
  const accept = vi.spyOn(runtime, 'acceptPtyDataBounded')
  await runtime.prepareDelegatedPtyModelFrame(identity, frame)
  expect(accept).not.toHaveBeenCalled()
  recovered.adapter.acceptPostCommitOutput(frame)
  recovered.outbox.acknowledge(identity, 1)
  const next = { seq: 2, data: 'next\n' }
  recovered.outbox.enqueue(identity, next)
  await runtime.prepareDelegatedPtyModelFrame(identity, next)
  expect(accept).toHaveBeenCalledOnce()
  expect(runtime.getPtyOutputSequence(binding.ptyId)).toBe(frame.data.length + next.data.length)
})

it('fences ambiguous model failure instead of replaying possibly applied output', async () => {
  const fixture = setup()
  const accept = vi.spyOn(fixture.runtime, 'acceptPtyDataBounded').mockImplementationOnce(() => {
    throw new Error('ambiguous write')
  })
  await expect(fixture.runtime.prepareDelegatedPtyModelFrame(identity, frame)).rejects.toThrow(
    'ambiguous write'
  )
  await expect(fixture.runtime.prepareDelegatedPtyModelFrame(identity, frame)).rejects.toThrow(
    'ingress_unavailable'
  )
  expect(accept).toHaveBeenCalledOnce()
  expect(fixture.outputOutbox.load(identity)?.pendingFrames).toHaveLength(1)
})

it('drains through real model ingestion and retains a failed workspace projection for retry', async () => {
  const fixture = setup()
  const accept = vi.spyOn(fixture.runtime, 'acceptPtyDataBounded')
  vi.spyOn(fixture.store, 'checkpointPtyOwnershipTransferTerminalModel').mockImplementationOnce(
    () => {
      throw new Error('projection failed')
    }
  )
  const drain = () =>
    drainOrcadDelegatedOutput({
      identity,
      adapter: fixture.adapter,
      outbox: fixture.outputOutbox,
      isActive: () => true,
      prepareModelFrame: (output) => fixture.runtime.prepareDelegatedPtyModelFrame(identity, output)
    })
  await expect(drain()).rejects.toThrow('projection failed')
  expect(fixture.outputOutbox.load(identity)?.pendingFrames).toHaveLength(1)
  await expect(drain()).resolves.toMatchObject({ acknowledgedEndSeq: 1, hasPending: false })
  expect(accept).toHaveBeenCalledOnce()
})

it('resumes only the remaining suffix of a saved partial frame', async () => {
  const fixture = setup()
  const data = frame.data.slice(0, 3)
  const admission = fixture.runtime.acceptPtyDataBounded(binding.ptyId, data, Date.now())
  await admission.completion
  await fixture.runtime.checkpointPtyOwnershipTransferModel({
    ptyId: binding.ptyId,
    ptyIncarnation: identity.incarnationId,
    data,
    modelSequenceEnd: admission.sequence,
    projectionSequenceEnd: admission.sequence,
    ownershipTransfer: {
      ...identity,
      version: 1,
      frameSeq: 1,
      fragmentStartSu: 0,
      fragmentEndSu: data.length,
      frameLengthSu: frame.data.length
    }
  })
  const runtime = runtimeFor(fixture.store)
  const recovered = runtime
    .getPtyOwnershipTransferDestinationRegistry()!
    .recoverPersistedDelegatedDestinations()[0]
  await runtime.restoreDelegatedPtyOwnershipModel(identity)
  const accept = vi.spyOn(runtime, 'acceptPtyDataBounded')
  await runtime.prepareDelegatedPtyModelFrame(identity, frame)
  expect(accept.mock.calls[0][1]).toBe(frame.data.slice(3))
  expect(runtime.getPtyOutputSequence(binding.ptyId)).toBe(frame.data.length)
  recovered.adapter.acceptPostCommitOutput(frame)
  recovered.outbox.acknowledge(identity, 1)
})
