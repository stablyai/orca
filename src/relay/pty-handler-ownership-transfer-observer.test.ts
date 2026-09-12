import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PtyHandler } from './pty-handler'
import type { PtyOwnershipTransferOutputFragment } from '../shared/pty-ownership-transfer-output-envelope'
import { beginPtyHandlerTest, endPtyHandlerTest, testPtyId } from './pty-handler-test-harness'
import type { MockDispatcher } from './pty-handler-test-harness'

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

describe('PtyHandler ownership-transfer output observer', () => {
  let dispatcher: MockDispatcher
  let handler: PtyHandler
  let originalPlatform: PropertyDescriptor | undefined

  beforeEach(() => {
    ;({ dispatcher, handler, originalPlatform } = beginPtyHandlerTest({
      mockPtySpawn,
      mockPtyInstance,
      mockCreateShellPromptReadinessProbe
    }))
  })

  afterEach(async () => {
    await endPtyHandlerTest(handler, originalPlatform)
  })

  it('observes post-ingress output and removes the terminal on exit', async () => {
    let dataCallback: ((data: string) => void) | undefined
    let exitCallback: ((event: { exitCode: number }) => void) | undefined
    mockPtySpawn.mockReturnValueOnce({
      ...mockPtyInstance,
      onData: vi.fn((callback: (data: string) => void) => {
        dataCallback = callback
      }),
      onExit: vi.fn((callback: (event: { exitCode: number }) => void) => {
        exitCallback = callback
      })
    })
    const observer = {
      observeOutput: vi.fn(),
      removeTerminal: vi.fn()
    }
    handler.setOwnershipTransferOutputObserver(observer)

    await dispatcher.callRequest('pty.spawn', {})
    dataCallback?.('hello')
    expect(observer.observeOutput).toHaveBeenCalledWith(testPtyId(1), 'hello', '0:5', undefined, {
      emissionId: '0:5',
      rawStartSu: 0,
      rawEndSu: 5,
      displayStartSu: 0,
      displayEndSu: 5,
      displayLengthSu: 5
    })

    exitCallback?.({ exitCode: 0 })
    expect(observer.removeTerminal).toHaveBeenCalledWith(testPtyId(1))
  })

  it('advertises mutation routes only after the explicit runtime opt-in', async () => {
    const dormant = await dispatcher.callRequest('pty.getOwnershipBridgeCapabilities')
    expect(dormant).toMatchObject({
      liveTransfer: false,
      destinationOutput: false,
      destinationControl: false,
      authoritativeExit: false,
      postCommitReplay: false,
      reconnectRekey: false,
      statusQuery: true
    })

    handler.setOwnershipTransferMutationEnabled(true)
    const enabled = await dispatcher.callRequest('pty.getOwnershipBridgeCapabilities')
    expect(enabled).toMatchObject({
      liveTransfer: true,
      destinationOutput: true,
      destinationControl: true,
      authoritativeExit: true,
      postCommitReplay: true,
      reconnectRekey: true,
      statusQuery: true
    })
  })

  it('contains observer failures without downgrading to untagged PTY publication', async () => {
    let dataCallback: ((data: string) => void) | undefined
    mockPtySpawn.mockReturnValueOnce({
      ...mockPtyInstance,
      onData: vi.fn((callback: (data: string) => void) => {
        dataCallback = callback
      })
    })
    const observeOutput = vi.fn((): readonly PtyOwnershipTransferOutputFragment[] => {
      throw new Error('observer unavailable')
    })
    const observer = {
      observeOutput,
      removeTerminal: vi.fn(() => {
        throw new Error('observer unavailable')
      })
    }
    handler.setOwnershipTransferOutputObserver(observer)

    await dispatcher.callRequest('pty.spawn', {})
    expect(() => dataCallback?.('still published')).not.toThrow()
    vi.advanceTimersByTime(8)
    expect(dispatcher.notify).not.toHaveBeenCalledWith('pty.data', expect.anything())
    expect(mockPtyInstance.pause).toHaveBeenCalled()

    observeOutput.mockReturnValueOnce([
      {
        data: 'still published',
        ownershipTransfer: {
          bridgeId: 'bridge-1',
          terminalId: testPtyId(1),
          incarnationId: 'incarnation-1',
          ownerLease: 'lease-1',
          sourceOwnerGeneration: 1,
          destinationRuntimeId: 'runtime-1',
          version: 1 as const,
          frameSeq: 1,
          fragmentStartSu: 0,
          fragmentEndSu: 15,
          frameLengthSu: 15
        }
      }
    ])
    vi.advanceTimersByTime(8)
    expect(dispatcher.notify).toHaveBeenCalledWith('pty.data', {
      id: testPtyId(1),
      data: 'still published',
      ownershipTransfer: expect.objectContaining({ bridgeId: 'bridge-1', frameSeq: 1 })
    })
  })

  it('propagates observer fragments as additive pty.data metadata', async () => {
    let dataCallback: ((data: string) => void) | undefined
    mockPtySpawn.mockReturnValueOnce({
      ...mockPtyInstance,
      onData: vi.fn((callback: (data: string) => void) => {
        dataCallback = callback
      })
    })
    const observer = {
      observeOutput: vi.fn(() => [
        {
          data: 'transfer',
          ownershipTransfer: {
            bridgeId: 'bridge-1',
            terminalId: testPtyId(1),
            incarnationId: 'incarnation-1',
            ownerLease: 'lease-1',
            sourceOwnerGeneration: 1,
            destinationRuntimeId: 'runtime-1',
            version: 1 as const,
            frameSeq: 2,
            fragmentStartSu: 0,
            fragmentEndSu: 8,
            frameLengthSu: 8
          }
        }
      ])
    }
    handler.setOwnershipTransferOutputObserver(observer)

    await dispatcher.callRequest('pty.spawn', {})
    dataCallback?.('transfer')
    vi.advanceTimersByTime(8)

    expect(dispatcher.notify).toHaveBeenCalledWith('pty.data', {
      id: testPtyId(1),
      data: 'transfer',
      ownershipTransfer: expect.objectContaining({ bridgeId: 'bridge-1', frameSeq: 2 })
    })
  })

  it('fences incumbent input while accepting destination-tagged input', async () => {
    const spawned = (await dispatcher.callRequest('pty.spawn', {})) as {
      id: string
      incarnationId: string
    }
    expect(handler.resolveOwnershipTransferTerminal(spawned.id)).toEqual({
      terminalId: spawned.id,
      incarnationId: spawned.incarnationId
    })

    dispatcher.callNotification('pty.data', { id: spawned.id, data: 'incumbent-before\n' })
    handler.setOwnershipTransferInputFenced(spawned.id, true)
    dispatcher.callNotification('pty.data', { id: spawned.id, data: 'incumbent-after\n' })
    expect(handler.writeOwnershipTransferInput(spawned.id, 'destination\n')).toBe(true)

    expect(mockPtyInstance.write.mock.calls).toEqual([['incumbent-before\n'], ['destination\n']])
    handler.setOwnershipTransferInputFenced(spawned.id, false)
    dispatcher.callNotification('pty.data', { id: spawned.id, data: 'incumbent-restored\n' })
    expect(mockPtyInstance.write).toHaveBeenLastCalledWith('incumbent-restored\n')
  })

  it('fences incumbent control mutations while ownership transfer is active', async () => {
    const spawned = (await dispatcher.callRequest('pty.spawn', {})) as { id: string }
    handler.setOwnershipTransferInputFenced(spawned.id, true)

    dispatcher.callNotification('pty.resize', { id: spawned.id, cols: 120, rows: 40 })
    await dispatcher.callRequest('pty.sendSignal', { id: spawned.id, signal: 'SIGTERM' })
    await expect(
      dispatcher.callRequest('pty.shutdown', { id: spawned.id, immediate: false })
    ).rejects.toThrow('pty_ownership_transfer_source_shutdown_fenced')
    await dispatcher.callRequest('pty.clearBuffer', { id: spawned.id })

    expect(mockPtyInstance.resize).not.toHaveBeenCalled()
    expect(mockPtyInstance.kill).not.toHaveBeenCalled()
    expect(mockPtyInstance.clear).not.toHaveBeenCalled()
    expect(handler.activePtyCount).toBe(1)
  })

  it('fails closed when fencing or writing a terminal that is not live', () => {
    expect(() => handler.setOwnershipTransferInputFenced('missing', true)).toThrow(
      'pty_ownership_transfer_source_terminal_gone'
    )
    expect(handler.writeOwnershipTransferInput('missing', 'data')).toBe(false)
  })

  it('refuses a new transfer fence once relay disposal has started', async () => {
    const spawned = (await dispatcher.callRequest('pty.spawn', {})) as { id: string }
    const disposal = handler.dispose({ waitForPhysicalExit: false })
    expect(() => handler.setOwnershipTransferInputFenced(spawned.id, true)).toThrow(
      'pty_ownership_transfer_source_shutdown_pending'
    )
    expect(handler.hasLiveOwnershipTransferFence).toBe(false)
    await disposal
  })

  it('does not retain the grace protection after a fenced PTY physically exits', async () => {
    let exit: ((event: { exitCode: number }) => void) | undefined
    mockPtySpawn.mockReturnValueOnce({
      ...mockPtyInstance,
      onExit: vi.fn((callback: (event: { exitCode: number }) => void) => {
        exit = callback
      })
    })
    const spawned = (await dispatcher.callRequest('pty.spawn', {})) as { id: string }
    handler.setOwnershipTransferInputFenced(spawned.id, true)
    expect(handler.hasLiveOwnershipTransferFence).toBe(true)
    exit!({ exitCode: 0 })
    expect(handler.hasLiveOwnershipTransferFence).toBe(false)
  })

  it('advertises the shutdown guard only while transfer mutations are enabled', async () => {
    expect(
      await dispatcher.callRequest('pty.getOwnershipBridgeCapabilities', {})
    ).not.toHaveProperty('preparationShutdownGuardVersion')
    handler.setOwnershipTransferMutationEnabled(true)
    expect(await dispatcher.callRequest('pty.getOwnershipBridgeCapabilities', {})).toHaveProperty(
      'preparationShutdownGuardVersion',
      1
    )
    handler.setOwnershipTransferMutationEnabled(false)
    expect(
      await dispatcher.callRequest('pty.getOwnershipBridgeCapabilities', {})
    ).not.toHaveProperty('preparationShutdownGuardVersion')
  })

  it.each(['linux', 'darwin', 'win32'])(
    'refuses a new fence after shutdown on %s',
    async (platform) => {
      const stopped = (await dispatcher.callRequest('pty.spawn', {})) as { id: string }
      const other = (await dispatcher.callRequest('pty.spawn', {})) as { id: string }
      Object.defineProperty(process, 'platform', { configurable: true, value: platform })
      await dispatcher.callRequest('pty.shutdown', { id: stopped.id, immediate: false })
      expect(() => handler.setOwnershipTransferInputFenced(stopped.id, true)).toThrow(
        'pty_ownership_transfer_source_shutdown_pending'
      )
      expect(handler.writeOwnershipTransferInput(stopped.id, 'destination')).toBe(false)
      expect(() => handler.setOwnershipTransferInputFenced(other.id, true)).not.toThrow()
    }
  )
})
