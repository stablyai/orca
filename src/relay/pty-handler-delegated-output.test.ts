import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PtyHandler } from './pty-handler'
import { beginPtyHandlerTest, endPtyHandlerTest, testPtyId } from './pty-handler-test-harness'
import type { MockDispatcher } from './pty-handler-test-harness'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RelayPtyOwnershipTransferFileStore } from './relay-pty-ownership-transfer-file-store'
import {
  makeDelegatedRelay,
  preparation,
  request,
  context
} from './relay-pty-ownership-transfer-delegation-test-fixture'
import type { MethodHandler, RelayDispatcher } from './dispatcher'
import {
  PTY_OWNERSHIP_TRANSFER_DESTINATION_SUBSCRIBE_METHOD,
  PTY_OWNERSHIP_TRANSFER_DESTINATION_COMMIT_METHOD
} from '../shared/pty-ownership-transfer-destination-claim'

const { mockPtySpawn, mockPtyInstance, mockCreateShellPromptReadinessProbe } = vi.hoisted(() => ({
  mockPtySpawn: vi.fn(),
  mockCreateShellPromptReadinessProbe: vi.fn(),
  mockPtyInstance: {
    pid: process.pid,
    onData: vi.fn(),
    onExit: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    clear: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn()
  }
}))

vi.mock('node-pty', () => ({ spawn: mockPtySpawn }))
vi.mock('../main/pty/posix-pty-process-groups', () => ({
  forceKillPosixPtyProcessGroups: vi.fn((_pid: number, fallback: () => void) => fallback())
}))
vi.mock('../main/shell-prompt-readiness-probe', () => ({
  createShellPromptReadinessProbe: mockCreateShellPromptReadinessProbe
}))

describe('PtyHandler delegated output publication', () => {
  let dispatcher: MockDispatcher
  let handler: PtyHandler
  let originalPlatform: PropertyDescriptor | undefined
  let emit: (data: string) => void
  let exit: (event: { exitCode: number }) => void

  beforeEach(() => {
    ;({ dispatcher, handler, originalPlatform } = beginPtyHandlerTest({
      mockPtySpawn,
      mockPtyInstance,
      mockCreateShellPromptReadinessProbe
    }))
    mockPtySpawn.mockReturnValueOnce({
      ...mockPtyInstance,
      onData: vi.fn((callback: typeof emit) => {
        emit = callback
      }),
      onExit: vi.fn((callback: typeof exit) => {
        exit = callback
      })
    })
  })

  afterEach(async () => {
    await endPtyHandlerTest(handler, originalPlatform)
  })

  it('advertises capture capability only while explicitly installed', async () => {
    expect(
      await dispatcher.callRequest('pty.getOwnershipBridgeCapabilities', {})
    ).not.toHaveProperty('captureBoundaryVersion')
    handler.setOwnershipTransferCaptureEnabled(true)
    expect(
      await dispatcher.callRequest('pty.getOwnershipBridgeCapabilities', {})
    ).not.toHaveProperty('captureSelectionVersion')
    expect(await dispatcher.callRequest('pty.getOwnershipBridgeCapabilities', {})).toMatchObject({
      captureBoundaryVersion: 1
    })
    handler.setOwnershipTransferCaptureEnabled(false)
    expect(
      await dispatcher.callRequest('pty.getOwnershipBridgeCapabilities', {})
    ).not.toHaveProperty('captureBoundaryVersion')
    handler.setOwnershipTransferCaptureEnabled(true, true)
    expect(await dispatcher.callRequest('pty.getOwnershipBridgeCapabilities', {})).toMatchObject({
      captureSelectionVersion: 1
    })
    expect(
      await dispatcher.callRequest('pty.getOwnershipBridgeCapabilities', {})
    ).not.toHaveProperty('captureSelectionRecoveryVersion')
    handler.setOwnershipTransferCaptureEnabled(true, true, true)
    expect(await dispatcher.callRequest('pty.getOwnershipBridgeCapabilities', {})).toHaveProperty(
      'captureSelectionRecoveryVersion',
      1
    )
    handler.setOwnershipTransferCaptureEnabled(false)
    expect(
      await dispatcher.callRequest('pty.getOwnershipBridgeCapabilities', {})
    ).not.toHaveProperty('captureSelectionVersion')
    expect(
      await dispatcher.callRequest('pty.getOwnershipBridgeCapabilities', {})
    ).not.toHaveProperty('captureSelectionRecoveryVersion')
  })

  it('invalidates capture on late output without dropping bytes or clearing a consumer pause', async () => {
    await dispatcher.callRequest('pty.spawn', {})
    const id = testPtyId(1)
    const incarnation = handler.resolveOwnershipTransferTerminal(id)!.incarnationId
    const lease = handler.beginOwnershipTransferCaptureIngress(id, incarnation, () => true)
    expect(lease.isCurrent()).toBe(true)
    expect(lease.inspectRawCursor?.()).toBe(0)
    expect(mockPtyInstance.pause).toHaveBeenCalledOnce()
    emit('late output')
    vi.advanceTimersByTime(20)
    expect(lease.isCurrent()).toBe(false)
    expect(lease.inspectRawCursor?.()).toBeNull()
    expect(dispatcher.notify).toHaveBeenCalledWith('pty.data', { id, data: 'late output' })
    expect(mockPtyInstance.resume).not.toHaveBeenCalled()
    handler.setConsumerDeliveryPaused(id, true)
    lease.release()
    expect(mockPtyInstance.resume).not.toHaveBeenCalled()
    handler.setConsumerDeliveryPaused(id, false)
    expect(mockPtyInstance.resume).toHaveBeenCalledOnce()
    const after = handler.beginOwnershipTransferCaptureIngress(id, incarnation, () => true)
    expect(after.inspectRawCursor?.()).toBe('late output'.length)
    after.release()
  })

  it('expires capture without leaving the native PTY paused and fences a stale release', async () => {
    await dispatcher.callRequest('pty.spawn', {})
    const id = testPtyId(1)
    const incarnation = handler.resolveOwnershipTransferTerminal(id)!.incarnationId
    const lease = handler.beginOwnershipTransferCaptureIngress(id, incarnation, () => true)
    vi.advanceTimersByTime(5_000)
    expect(lease.isCurrent()).toBe(false)
    expect(mockPtyInstance.resume).toHaveBeenCalledOnce()
    const next = handler.beginOwnershipTransferCaptureIngress(id, incarnation, () => true)
    lease.release()
    expect(next.isCurrent()).toBe(true)
    next.release()
    expect(mockPtyInstance.resume).toHaveBeenCalledTimes(2)
  })

  it('requires the exact incarnation and rechecks authorization during capture', async () => {
    await dispatcher.callRequest('pty.spawn', {})
    const id = testPtyId(1)
    const incarnation = handler.resolveOwnershipTransferTerminal(id)!.incarnationId
    expect(() => handler.beginOwnershipTransferCaptureIngress(id, 'other', () => true)).toThrow(
      'unavailable'
    )
    expect(() =>
      handler.beginOwnershipTransferCaptureIngress(id, incarnation, () => false)
    ).toThrow('unavailable')
    let authorized = true
    const lease = handler.beginOwnershipTransferCaptureIngress(id, incarnation, () => authorized)
    authorized = false
    expect(lease.isCurrent()).toBe(false)
    authorized = true
    expect(lease.isCurrent()).toBe(false)
    lease.release()
  })

  it('invalidates capture for buffered raw input, buffer clearing, and physical exit', async () => {
    await dispatcher.callRequest('pty.spawn', {})
    const id = testPtyId(1)
    const incarnation = handler.resolveOwnershipTransferTerminal(id)!.incarnationId
    const capture = () => handler.beginOwnershipTransferCaptureIngress(id, incarnation, () => true)
    const first = capture()
    emit('\x1b[')
    expect(first.isCurrent()).toBe(false)
    first.release()
    const second = capture()
    await dispatcher.callRequest('pty.clearBuffer', { id })
    expect(second.isCurrent()).toBe(false)
    second.release()
    const third = capture()
    exit({ exitCode: 0 })
    expect(third.isCurrent()).toBe(false)
    expect(capture).toThrow('unavailable')
  })

  it('waits for queued pre-capture output and refuses drain evidence inside a reentrant send', async () => {
    await dispatcher.callRequest('pty.spawn', {})
    const id = testPtyId(1)
    const incarnation = handler.resolveOwnershipTransferTerminal(id)!.incarnationId
    emit('before capture')
    const lease = handler.beginOwnershipTransferCaptureIngress(id, incarnation, () => true)
    expect(lease.isCurrent()).toBe(true)
    expect(lease.isDrained()).toBe(false)
    const notify = dispatcher.notify.getMockImplementation()
    const duringSend: boolean[] = []
    dispatcher.notify.mockImplementation((...args) => {
      if (args[0] === 'pty.data') {
        duringSend.push(lease.isDrained())
      }
      return notify?.(...args)
    })
    vi.advanceTimersByTime(20)
    expect(duringSend).toEqual([false])
    expect(lease.isDrained()).toBe(true)
    expect(mockPtyInstance.resume).not.toHaveBeenCalled()
    lease.release()
    expect(lease.isDrained()).toBe(false)
  })

  it.each([false, true])(
    'suppresses source output only when delegated ownership is %s',
    async (owns) => {
      const observer = { observeOutput: vi.fn(), ownsOutputPublication: vi.fn(() => owns) }
      handler.setOwnershipTransferOutputObserver(observer)
      await dispatcher.callRequest('pty.spawn', {})
      emit('hello')
      vi.advanceTimersByTime(20)
      expect(observer.observeOutput).toHaveBeenCalledWith(testPtyId(1), 'hello', '0:5', undefined, {
        emissionId: '0:5',
        rawStartSu: 0,
        rawEndSu: 5,
        displayStartSu: 0,
        displayEndSu: 5,
        displayLengthSu: 5
      })
      const published = dispatcher.notify.mock.calls.filter(([method]) => method === 'pty.data')
      expect(published).toEqual(owns ? [] : [['pty.data', { id: testPtyId(1), data: 'hello' }]])
    }
  )

  it('preserves the durable delegated output fence through adapter reload without stopping the PTY', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-source-output-fence-'))
    try {
      await dispatcher.callRequest('pty.spawn', {})
      const id = testPtyId(1)
      const source = {
        ...preparation,
        terminalId: id,
        incarnationId: handler.resolveOwnershipTransferTerminal(id)!.incarnationId
      }
      const store = new RelayPtyOwnershipTransferFileStore(directory)
      const createAdapter = () =>
        makeDelegatedRelay(store, {
          resolveSource: () => source,
          resolveTerminalIncarnation: (terminalId) =>
            handler.resolveOwnershipTransferTerminal(terminalId)?.incarnationId ?? null,
          hasPendingSourceOutput: (terminalId) =>
            handler.hasPendingOwnershipTransferOutput(terminalId),
          setInputFenced: (terminalId, fenced) =>
            handler.setOwnershipTransferInputFenced(terminalId, fenced),
          enableDestinationOutputRetention: true,
          enableDestinationOutputRoutes: true,
          enableDestinationDelegationCommit: true
        })
      const adapter = createAdapter()
      handler.setOwnershipTransferOutputObserver(adapter)
      adapter.prepare({
        ...source,
        surfacePublication: {
          ...preparation.surfacePublication,
          surfaceBinding: { ...preparation.surfacePublication.surfaceBinding, ptyId: id }
        }
      })
      const proof = { ...request(), terminalId: id, incarnationId: source.incarnationId }
      adapter.claimDestination(proof, context())
      const handlers = new Map<string, MethodHandler>()
      adapter.register({
        onRequest: (method: string, callback: MethodHandler) => handlers.set(method, callback),
        onLegacyPtyCapacity: () => () => {},
        onClientDetached: () => () => {},
        onDisposed: () => () => {},
        publishProducerNotification: () => true
      } as unknown as RelayDispatcher)
      const claim = { ...proof, destinationClaim: { generation: 1, claimId: 'claim-1' } }
      await handlers.get(PTY_OWNERSHIP_TRANSFER_DESTINATION_SUBSCRIBE_METHOD)!(
        { ...claim, afterSeq: 0 },
        context()
      )
      await handlers.get(PTY_OWNERSHIP_TRANSFER_DESTINATION_COMMIT_METHOD)!(
        {
          ...claim,
          acceptedSourceEndSeq: 0,
          receipt: {
            bridgeId: proof.bridgeId,
            acceptedSourceEndSeq: 0,
            receiptId: 'commit',
            committedAt: '2026-09-07T00:00:00.000Z'
          }
        },
        context()
      )
      expect(store.loadAll()[0].phase).toBe('committed')
      const assertLegacyControlsFenced = async () => {
        mockPtyInstance.write.mockClear()
        mockPtyInstance.resize.mockClear()
        mockPtyInstance.clear.mockClear()
        dispatcher.callNotification('pty.data', { id, data: 'stale command\n' })
        dispatcher.callNotification('pty.resize', { id, cols: 120, rows: 40 })
        await dispatcher.callRequest('pty.clearBuffer', { id })
        await dispatcher.callRequest('pty.sendSignal', { id, signal: 'SIGTERM' })
        await expect(
          dispatcher.callRequest('pty.shutdown', { id, immediate: true })
        ).rejects.toThrow('pty_ownership_transfer_source_shutdown_fenced')
        await expect(dispatcher.callRequest('pty.attach', { id })).rejects.toThrow(
          'legacy_attachment_fenced'
        )
        expect(mockPtyInstance.write).not.toHaveBeenCalled()
        expect(mockPtyInstance.resize).not.toHaveBeenCalled()
        expect(mockPtyInstance.clear).not.toHaveBeenCalled()
        expect(mockPtyInstance.kill).not.toHaveBeenCalled()
      }
      await assertLegacyControlsFenced()
      dispatcher.notify.mockClear()
      emit('first')
      vi.advanceTimersByTime(20)
      expect(handler.hasPendingOwnershipTransferOutput(id)).toBe(false)
      const restoreFence = vi.spyOn(handler, 'setOwnershipTransferInputFenced')
      const restored = createAdapter()
      expect(restoreFence).toHaveBeenCalledWith(id, true)
      handler.setOwnershipTransferOutputObserver(restored)
      expect(restored.ownsOutputPublication(id)).toBe(true)
      expect(restored.fencesLegacyAttachment(id)).toBe(true)
      await assertLegacyControlsFenced()
      emit('second')
      vi.advanceTimersByTime(20)
      expect(
        dispatcher.notify.mock.calls.filter(
          ([method]) => method === 'pty.data' || method === 'pty.exit'
        )
      ).toEqual([])
      expect(mockPtyInstance.kill).not.toHaveBeenCalled()
      expect(handler.resolveOwnershipTransferTerminal(id)?.incarnationId).toBe(source.incarnationId)
      expect(store.loadAll()[0].history.frames.map((frame) => frame.data)).toEqual([
        'first',
        'second'
      ])
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('retains failed observations and drains retries without source publication or residual pause', async () => {
    let writable = false
    const accepted: string[] = []
    handler.setOwnershipTransferOutputObserver({
      ownsOutputPublication: () => true,
      observeOutput: (_id, data) => {
        if (!writable) {
          throw new Error('journal unavailable')
        }
        accepted.push(data)
        return undefined
      }
    })
    await dispatcher.callRequest('pty.spawn', {})
    emit('first')
    emit('second')
    vi.advanceTimersByTime(8)
    expect(mockPtyInstance.pause).toHaveBeenCalled()
    expect(mockPtyInstance.resume).not.toHaveBeenCalled()
    expect(handler.hasPendingOwnershipTransferOutput(testPtyId(1))).toBe(true)
    writable = true
    vi.advanceTimersByTime(40)
    expect(accepted).toEqual(['first', 'second'])
    expect(handler.hasPendingOwnershipTransferOutput(testPtyId(1))).toBe(false)
    expect(mockPtyInstance.resume).toHaveBeenCalledTimes(1)
    expect(dispatcher.notify).not.toHaveBeenCalledWith('pty.data', expect.anything())
    expect(dispatcher.notify).not.toHaveBeenCalledWith('pty.exit', expect.anything())
  })

  it('keeps pending transfer output intact when a legacy attachment is fenced', async () => {
    handler.setOwnershipTransferOutputObserver({
      fencesLegacyAttachment: () => true,
      observeOutput: () => {
        throw new Error('journal unavailable')
      }
    })
    await dispatcher.callRequest('pty.spawn', {})
    emit('retained')
    vi.advanceTimersByTime(8)
    await expect(dispatcher.callRequest('pty.attach', { id: testPtyId(1) })).rejects.toThrow(
      'legacy_attachment_fenced'
    )
    expect(handler.hasPendingOwnershipTransferOutput(testPtyId(1))).toBe(true)
    expect(dispatcher.notify).not.toHaveBeenCalledWith('pty.replay', expect.anything())
  })

  it('rechecks the delegation fence after an asynchronous source checkpoint barrier', async () => {
    let fenced = false
    let settle!: () => void
    const activate = vi.fn()
    handler.setOwnershipTransferOutputObserver({
      observeOutput: vi.fn(),
      fencesLegacyAttachment: () => fenced
    })
    const spawned = (await dispatcher.callRequest('pty.spawn', {})) as {
      id: string
      incarnationId: string
    }
    handler.setSourcePublication({
      waitForPendingSend: () =>
        new Promise<boolean>((resolve) => {
          settle = () => resolve(true)
        }),
      activate,
      accepts: () => false,
      dispose: vi.fn()
    } as never)
    const attaching = dispatcher.callRequest('pty.attach', {
      id: spawned.id,
      sourceRecovery: {
        status: 'checkpoint',
        deliveryToken: 'old-token',
        ptyIncarnation: spawned.incarnationId,
        clientGeneration: 1,
        ownerGeneration: 1,
        acceptedSourceEndSu: 0
      }
    })
    fenced = true
    settle()
    await expect(attaching).rejects.toThrow('legacy_attachment_fenced')
    expect(activate).not.toHaveBeenCalled()
  })

  it('does not publish legacy exit while delegated exit persistence is retrying', async () => {
    let writable = false
    const observeExit = vi.fn(() => {
      if (!writable) {
        throw new Error('exit journal unavailable')
      }
    })
    handler.setOwnershipTransferOutputObserver({
      observeOutput: vi.fn(),
      ownsOutputPublication: () => true,
      observeExit
    })
    await dispatcher.callRequest('pty.spawn', {})
    exit({ exitCode: 17 })
    vi.advanceTimersByTime(10)
    expect(dispatcher.notify).not.toHaveBeenCalledWith('pty.exit', expect.anything())
    writable = true
    vi.advanceTimersByTime(50)
    expect(observeExit).toHaveBeenCalled()
    expect(dispatcher.notify).not.toHaveBeenCalledWith('pty.exit', expect.anything())
  })

  it('observes all bounded slices before exit without publishing the original emission', async () => {
    const accepted: string[] = []
    const spans: unknown[] = []
    const observeExit = vi.fn(() => {
      expect(accepted.join('')).toBe('éééend')
    })
    handler.setOwnershipTransferOutputObserver({
      ownsOutputPublication: () => true,
      getPreparedOutputByteLimit: () => 4,
      observeOutput: (_id, data, _key, _incarnation, span) => {
        if (Buffer.byteLength(data) > 4) {
          throw new Error('retention full')
        }
        accepted.push(data)
        spans.push(span)
        return undefined
      },
      observeExit
    })
    await dispatcher.callRequest('pty.spawn', {})
    emit('éééend')
    exit({ exitCode: 0 })
    expect(observeExit).not.toHaveBeenCalled()
    vi.advanceTimersByTime(50)
    expect(accepted).toEqual(['éé', 'éen', 'd'])
    expect(spans).toEqual([
      {
        emissionId: '0:6',
        rawStartSu: 0,
        rawEndSu: 6,
        displayLengthSu: 6,
        displayStartSu: 0,
        displayEndSu: 2
      },
      {
        emissionId: '0:6',
        rawStartSu: 0,
        rawEndSu: 6,
        displayLengthSu: 6,
        displayStartSu: 2,
        displayEndSu: 5
      },
      {
        emissionId: '0:6',
        rawStartSu: 0,
        rawEndSu: 6,
        displayLengthSu: 6,
        displayStartSu: 5,
        displayEndSu: 6
      }
    ])
    expect(observeExit).toHaveBeenCalledTimes(1)
    expect(handler.hasPendingOwnershipTransferOutput(testPtyId(1))).toBe(false)
    expect(dispatcher.notify).not.toHaveBeenCalledWith('pty.data', expect.anything())
  })

  it('fails closed if ownership cannot be established after successful observation', async () => {
    let verifiable = false
    const observeOutput = vi.fn()
    handler.setOwnershipTransferOutputObserver({
      observeOutput,
      ownsOutputPublication: () => {
        if (!verifiable) {
          throw new Error('ownership unavailable')
        }
        return true
      }
    })
    await dispatcher.callRequest('pty.spawn', {})
    emit('durable')
    vi.advanceTimersByTime(8)
    expect(handler.hasPendingOwnershipTransferOutput(testPtyId(1))).toBe(true)
    verifiable = true
    vi.advanceTimersByTime(20)
    expect(handler.hasPendingOwnershipTransferOutput(testPtyId(1))).toBe(false)
    expect(observeOutput.mock.calls.every((call) => call[2] === '0:7')).toBe(true)
    expect(dispatcher.notify).not.toHaveBeenCalledWith('pty.data', expect.anything())
  })
})
