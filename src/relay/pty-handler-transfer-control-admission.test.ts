import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PtyHandler } from './pty-handler'
import {
  beginPtyHandlerTest,
  endPtyHandlerTest,
  testPtyId,
  type MockDispatcher
} from './pty-handler-test-harness'
import type { PtyOwnershipTransferControl } from '../shared/pty-ownership-transfer-control-wire'

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

describe('transfer control mutation admission', () => {
  let dispatcher: MockDispatcher
  let handler: PtyHandler
  let originalPlatform: PropertyDescriptor | undefined
  let incarnation: string
  beforeEach(async () => {
    ;({ dispatcher, handler, originalPlatform } = beginPtyHandlerTest({
      mockPtySpawn,
      mockPtyInstance,
      mockCreateShellPromptReadinessProbe
    }))
    await dispatcher.callRequest('pty.spawn', {})
    incarnation = handler.resolveOwnershipTransferTerminal(testPtyId(1))!.incarnationId
    handler.setOwnershipTransferInputFenced(testPtyId(1), true)
  })
  afterEach(async () => endPtyHandlerTest(handler, originalPlatform))

  it.each<PtyOwnershipTransferControl>([
    { kind: 'resize', cols: 80, rows: 24 },
    { kind: 'sendSignal', signal: 'SIGTERM' },
    { kind: 'clearBuffer' },
    { kind: 'shutdown', immediate: true },
    { kind: 'shutdown', immediate: false }
  ])('refuses a revoked claim before applying $kind', async (control) => {
    const admission = vi.fn(() => false)
    await expect(
      handler.applyOwnershipTransferControl(testPtyId(1), incarnation, control, admission)
    ).rejects.toThrow('control_unauthorized')
    expect(admission).toHaveBeenCalledOnce()
    expect(mockPtyInstance.resize).not.toHaveBeenCalled()
    expect(mockPtyInstance.kill).not.toHaveBeenCalled()
    expect(mockPtyInstance.clear).not.toHaveBeenCalled()
  })

  it('fails closed if the admission probe throws', async () => {
    await expect(
      handler.applyOwnershipTransferControl(
        testPtyId(1),
        incarnation,
        { kind: 'resize', cols: 100, rows: 30 },
        () => {
          throw new Error('claim lookup failed')
        }
      )
    ).rejects.toThrow('claim lookup failed')
    expect(mockPtyInstance.resize).not.toHaveBeenCalled()
  })

  it('refuses source shutdown but still permits the authorized destination to stop its PTY', async () => {
    await expect(
      dispatcher.callRequest('pty.shutdown', { id: testPtyId(1), immediate: true })
    ).rejects.toThrow('pty_ownership_transfer_source_shutdown_fenced')
    expect(mockPtyInstance.kill).not.toHaveBeenCalled()
    await expect(
      handler.applyOwnershipTransferControl(
        testPtyId(1),
        incarnation,
        { kind: 'shutdown', immediate: false },
        () => true
      )
    ).resolves.toBe('applied')
    expect(mockPtyInstance.kill).toHaveBeenCalled()
  })

  it('applies a currently authorized resize and preserves ordinary calls', async () => {
    await expect(
      handler.applyOwnershipTransferControl(
        testPtyId(1),
        incarnation,
        { kind: 'resize', cols: 100, rows: 30 },
        () => true
      )
    ).resolves.toBe('applied')
    expect(mockPtyInstance.resize).toHaveBeenLastCalledWith(100, 30)
    await expect(
      handler.applyOwnershipTransferControl(testPtyId(1), incarnation, {
        kind: 'resize',
        cols: 120,
        rows: 40
      })
    ).resolves.toBe('applied')
    expect(mockPtyInstance.resize).toHaveBeenLastCalledWith(120, 40)
  })
})
