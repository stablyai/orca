import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createStore, testState } from '../persistence-test-harness'
import { OrcaRuntimeService } from './orca-runtime'
import { HeadlessEmulator } from '../daemon/headless-emulator'
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
  testState.dir = mkdtempSync(join(tmpdir(), 'orca-delegated-checkpoint-'))
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(testState.dir, { recursive: true, force: true })
})

async function setup(data = 'checkpoint output\n') {
  const store = createStore()
  const runtime = new OrcaRuntimeService(store, undefined, {
    runtimeId: identity.destinationRuntimeId
  })
  runtime.installPtyOwnershipTransferDestinationOutputBridge()
  const registry = runtime.getPtyOwnershipTransferDestinationRegistry()!
  const prepared = registry.prepareDelegated(
    {
      ...identity,
      version: 1,
      phase: 'prepared',
      sourceOutputEndSeq: 0,
      replayStartSeq: 1,
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
  prepared.adapter.commit({
    bridgeId: identity.bridgeId,
    receiptId: 'receipt',
    acceptedSourceEndSeq: 0,
    committedAt: '2026-09-06T00:00:00.000Z'
  })
  prepared.adapter.publish()
  const binding = preparation.surfacePublication.surfaceBinding
  runtime.registerPty(binding.ptyId, binding.workspaceKey, null, {
    tabId: binding.tabId,
    leafId: binding.leafId,
    incarnationId: identity.incarnationId
  })
  prepared.outputOutbox.enqueue(identity, { seq: 1, data })
  const admission = runtime.acceptPtyDataBounded(binding.ptyId, data, Date.now())
  await admission.completion
  const checkpoint = {
    ptyId: binding.ptyId,
    ptyIncarnation: identity.incarnationId,
    modelSequenceEnd: admission.sequence,
    projectionSequenceEnd: admission.sequence,
    data,
    ownershipTransfer: {
      ...identity,
      version: 1 as const,
      frameSeq: 1,
      fragmentStartSu: 0,
      fragmentEndSu: data.length,
      frameLengthSu: data.length
    }
  }
  const readProjection = () => {
    const ref =
      store.getWorkspaceSession().terminalLayoutsByTabId[binding.tabId]?.scrollbackRefsByLeafId?.[
        binding.leafId
      ]
    return ref ? store.readTerminalScrollbackSnapshot(ref) : null
  }
  return { store, runtime, registry, outbox: prepared.outputOutbox, checkpoint, readProjection }
}

it('persists an atomic model/cursor before publishing the workspace projection', async () => {
  const fixture = await setup()
  const publish = fixture.store.checkpointPtyOwnershipTransferTerminalModel.bind(fixture.store)
  vi.spyOn(fixture.store, 'checkpointPtyOwnershipTransferTerminalModel').mockImplementation(
    (request) => {
      const saved = fixture.outbox.loadModelSnapshot(identity)!
      expect(saved.modelData).toBe(request.modelData)
      expect(saved.checkpoint.modelSequenceEnd).toBe(fixture.checkpoint.modelSequenceEnd)
      expect(saved.checkpoint.data).toBe(fixture.checkpoint.data)
      publish(request)
    }
  )
  await fixture.runtime.checkpointPtyOwnershipTransferModel(fixture.checkpoint)
  expect(fixture.readProjection()).toContain('checkpoint output')
  await fixture.runtime.checkpointPtyOwnershipTransferModel(fixture.checkpoint)
})

it.each(['before', 'after'])(
  'repairs the projection from the atomic journal after a %s-publication failure',
  async (boundary) => {
    const fixture = await setup()
    const publish = fixture.store.checkpointPtyOwnershipTransferTerminalModel.bind(fixture.store)
    const failure = vi
      .spyOn(fixture.store, 'checkpointPtyOwnershipTransferTerminalModel')
      .mockImplementationOnce((request) => {
        if (boundary === 'after') {
          publish(request)
        }
        throw new Error('projection failed')
      })
    await expect(
      fixture.runtime.checkpointPtyOwnershipTransferModel(fixture.checkpoint)
    ).rejects.toThrow('projection failed')
    const saved = fixture.outbox.loadModelSnapshot(identity)!
    expect(saved.checkpoint.data).toBe(fixture.checkpoint.data)
    expect(fixture.outbox.load(identity)?.acknowledgedEndSeq).toBe(0)
    failure.mockRestore()
    const restarted = new OrcaRuntimeService(fixture.store, undefined, {
      runtimeId: identity.destinationRuntimeId
    })
    restarted.installPtyOwnershipTransferDestinationOutputBridge()
    const recovered = restarted
      .getPtyOwnershipTransferDestinationRegistry()!
      .recoverPersistedDelegatedDestinations()
    expect(recovered).toHaveLength(1)
    expect(recovered[0].outbox.loadModelSnapshot(identity)).toEqual(saved)
    expect(fixture.readProjection()).toBe(saved.modelData)
  }
)

it('does not publish new workspace bytes when the atomic journal write fails', async () => {
  const fixture = await setup()
  const before = fixture.readProjection()
  vi.spyOn(fixture.outbox, 'recordModelSnapshot').mockImplementationOnce(() => {
    throw new Error('journal failed')
  })
  const publish = vi.spyOn(fixture.store, 'checkpointPtyOwnershipTransferTerminalModel')
  await expect(
    fixture.runtime.checkpointPtyOwnershipTransferModel(fixture.checkpoint)
  ).rejects.toThrow('journal failed')
  expect(publish).not.toHaveBeenCalled()
  expect(fixture.readProjection()).toBe(before)
  expect(fixture.outbox.loadModelSnapshot(identity)).toBeNull()
})

function restart(fixture: Awaited<ReturnType<typeof setup>>) {
  const runtime = new OrcaRuntimeService(fixture.store, undefined, {
    runtimeId: identity.destinationRuntimeId
  })
  runtime.installPtyOwnershipTransferDestinationOutputBridge()
  runtime.getPtyOwnershipTransferDestinationRegistry()!.recoverPersistedDelegatedDestinations()
  const binding = preparation.surfacePublication.surfaceBinding
  runtime.registerPty(binding.ptyId, binding.workspaceKey, null, {
    tabId: binding.tabId,
    leafId: binding.leafId,
    incarnationId: identity.incarnationId
  })
  return runtime
}

it.each([false, true])(
  'restores a durable clear at the same sequence, with pending escape=%s',
  async (pendingEscape) => {
    const fixture = await setup(
      `old-history\r\n${'visible\r\n'.repeat(40)}${pendingEscape ? '\x1b[' : ''}`
    )
    await fixture.runtime.checkpointPtyOwnershipTransferModel(fixture.checkpoint)
    fixture.outbox.acknowledge(identity, 1)
    const saved = fixture.outbox.loadModelSnapshot(identity)!
    expect(saved.modelData).toContain('old-history')
    await fixture.runtime.clearHeadlessTerminalBuffer(fixture.checkpoint.ptyId)
    const cleared = (await fixture.runtime.serializeMainTerminalBuffer(fixture.checkpoint.ptyId))!
    const modelData = `${cleared.scrollbackAnsi ?? ''}${cleared.data}${cleared.frameRestoreAnsi ?? ''}`
    expect(modelData).not.toContain('old-history')
    fixture.outbox.recordModelClear(identity, {
      operationId: 'clear-checkpoint',
      expectedRevision: 0,
      throughSeq: 1,
      modelSequenceEnd: saved.checkpoint.modelSequenceEnd,
      model: { ...saved, modelData }
    })
    const runtime = restart(fixture)
    await runtime.restoreDelegatedPtyOwnershipModel(identity)
    const restored = await runtime.serializeMainTerminalBuffer(fixture.checkpoint.ptyId)
    expect(restored?.seq).toBe(saved.checkpoint.modelSequenceEnd)
    expect(restored?.data).not.toContain('old-history')
    if (pendingEscape) {
      expect(restored).toMatchObject({ pendingEscapeTailAnsi: '\x1b[' })
    }
    expect(fixture.readProjection()).not.toContain('old-history')
    expect(fixture.outbox.loadModelSnapshot(identity)).toEqual(saved)
    const suffix = pendingEscape ? 'mnext' : 'next'
    const admission = runtime.acceptPtyDataBounded(fixture.checkpoint.ptyId, suffix, Date.now())
    await admission.completion
    expect(admission.sequence).toBe(saved.checkpoint.modelSequenceEnd + suffix.length)
    const completed = await runtime.serializeMainTerminalBuffer(fixture.checkpoint.ptyId)
    expect(completed?.data).toContain('next')
    expect(completed?.data).not.toContain('mnext')
  }
)

it('restores modes, cwd, title, links and a dangling escape from the same checkpoint', async () => {
  const fixture = await setup(
    '\x1b[=5;1u\x1b]7;file://localhost/srv/retained\x07\x1b]0;retained-title\x07\x1b]8;;https://example.com\x07link\x1b]8;;\x07\x1b[3'
  )
  await fixture.runtime.checkpointPtyOwnershipTransferModel(fixture.checkpoint)
  const saved = fixture.outbox.loadModelSnapshot(identity)!
  expect(saved.restoreMetadata).toMatchObject({
    version: 1,
    kittyKeyboardFlags: 5,
    cwd: '/srv/retained',
    lastTitle: 'retained-title',
    pendingEscapeTailAnsi: '\x1b[3'
  })
  expect(saved.restoreMetadata?.oscLinks).toEqual(
    expect.arrayContaining([expect.objectContaining({ uri: 'https://example.com' })])
  )
  expect(saved.modelData.endsWith('\x1b[3')).toBe(false)
  const runtime = restart(fixture)
  await runtime.restoreDelegatedPtyOwnershipModel(identity)
  const restored = await runtime.serializeMainTerminalBuffer(fixture.checkpoint.ptyId)
  expect(restored).toMatchObject({
    kittyKeyboardFlags: 5,
    cwd: '/srv/retained',
    lastTitle: 'retained-title',
    pendingEscapeTailAnsi: '\x1b[3'
  })
  expect(restored?.oscLinks).toEqual(saved.restoreMetadata?.oscLinks)
  const next = runtime.acceptPtyDataBounded(fixture.checkpoint.ptyId, '1mR', Date.now())
  await next.completion
  const completed = await runtime.serializeMainTerminalBuffer(fixture.checkpoint.ptyId)
  expect(completed).not.toEqual(
    expect.objectContaining({ pendingEscapeTailAnsi: expect.stringMatching(/./) })
  )
  expect(completed?.data).not.toContain('1mR')
  expect(completed?.data).toContain('R')
})

it('restores model bytes, dimensions and sequence together before new live output', async () => {
  const fixture = await setup()
  await fixture.runtime.checkpointPtyOwnershipTransferModel(fixture.checkpoint)
  const runtime = restart(fixture)
  const saved = fixture.outbox.loadModelSnapshot(identity)!
  await expect(runtime.restoreDelegatedPtyOwnershipModel(identity)).resolves.toEqual(
    saved.checkpoint
  )
  expect(runtime.getPtyOutputSequence(fixture.checkpoint.ptyId)).toBe(
    saved.checkpoint.modelSequenceEnd
  )
  const restored = await runtime.serializeMainTerminalBuffer(fixture.checkpoint.ptyId)
  expect(restored).toMatchObject({
    cols: saved.cols,
    rows: saved.rows,
    seq: saved.checkpoint.modelSequenceEnd
  })
  expect(restored?.data.match(/checkpoint output/g)).toHaveLength(1)
  await expect(runtime.restoreDelegatedPtyOwnershipModel(identity)).rejects.toThrow(
    'restore_conflict'
  )
  const admission = runtime.acceptPtyDataBounded(fixture.checkpoint.ptyId, 'next\n', Date.now())
  await admission.completion
  expect(admission.sequence).toBe(saved.checkpoint.modelSequenceEnd + 5)
})

it('refuses restoration when the registered terminal has another incarnation', async () => {
  const fixture = await setup()
  await fixture.runtime.checkpointPtyOwnershipTransferModel(fixture.checkpoint)
  const runtime = restart(fixture)
  const binding = preparation.surfacePublication.surfaceBinding
  runtime.registerPty(binding.ptyId, binding.workspaceKey, null, {
    tabId: binding.tabId,
    leafId: binding.leafId,
    incarnationId: 'replacement'
  })
  await expect(runtime.restoreDelegatedPtyOwnershipModel(identity)).rejects.toThrow(
    'route_mismatch'
  )
  expect(runtime.getPtyOutputSequence(binding.ptyId)).toBe(0)
})

it('rejects failed emulator restore without advancing the cursor and permits a fresh retry', async () => {
  const fixture = await setup()
  await fixture.runtime.checkpointPtyOwnershipTransferModel(fixture.checkpoint)
  const runtime = restart(fixture)
  vi.spyOn(HeadlessEmulator.prototype, 'write').mockRejectedValueOnce(new Error('emulator failed'))
  await expect(runtime.restoreDelegatedPtyOwnershipModel(identity)).rejects.toThrow(
    'emulator failed'
  )
  expect(runtime.getPtyOutputSequence(fixture.checkpoint.ptyId)).toBe(0)
  await expect(runtime.restoreDelegatedPtyOwnershipModel(identity)).resolves.toMatchObject({
    frameSeq: 1
  })
})

it('fences live input to the model during restore and ignores a cancelled late seed', async () => {
  const fixture = await setup()
  await fixture.runtime.checkpointPtyOwnershipTransferModel(fixture.checkpoint)
  const runtime = restart(fixture)
  const controller = new AbortController()
  let finish!: () => void
  let entered!: () => void
  const waiting = new Promise<void>((resolve) => {
    entered = resolve
  })
  const write = HeadlessEmulator.prototype.write
  vi.spyOn(HeadlessEmulator.prototype, 'write').mockImplementationOnce(
    async function (this: HeadlessEmulator, data, options) {
      entered()
      await new Promise<void>((resolve) => {
        finish = resolve
      })
      await write.call(this, data, options)
    }
  )
  const restoring = runtime.restoreDelegatedPtyOwnershipModel(identity, controller.signal)
  await waiting
  expect(() =>
    runtime.acceptPtyDataBounded(fixture.checkpoint.ptyId, 'must retry', Date.now())
  ).toThrow('restore_in_progress')
  expect(runtime.getPtyOutputSequence(fixture.checkpoint.ptyId)).toBe(0)
  controller.abort()
  finish()
  await expect(restoring).rejects.toThrow()
  expect(runtime.getPtyOutputSequence(fixture.checkpoint.ptyId)).toBe(0)
  await expect(runtime.restoreDelegatedPtyOwnershipModel(identity)).resolves.toMatchObject({
    frameSeq: 1
  })
})
