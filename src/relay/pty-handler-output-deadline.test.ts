import './mock-descendant-sweep'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  beginPtyHandlerTest,
  createTestPtyHandler,
  endPtyHandlerTest
} from './pty-handler-test-harness'
import type { MockDispatcher } from './pty-handler-test-harness'
import type { PtyHandler } from './pty-handler'

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

vi.mock('./relay-pty-runtime', () => ({ bunRelayPtyModule: { spawn: mockPtySpawn } }))
vi.mock('../main/shell-prompt-readiness-probe', () => ({
  createShellPromptReadinessProbe: mockCreateShellPromptReadinessProbe
}))

describe('relay PTY output deadlines', () => {
  let handler: PtyHandler
  let dispatcher: MockDispatcher
  let originalPlatform: PropertyDescriptor | undefined
  let releaseCapacity: () => void
  let emitData: (data: string) => void

  beforeEach(async () => {
    const setup = beginPtyHandlerTest({
      mockPtySpawn,
      mockPtyInstance,
      mockCreateShellPromptReadinessProbe
    })
    dispatcher = setup.dispatcher
    originalPlatform = setup.originalPlatform
    await setup.handler.dispose({ waitForPhysicalExit: false })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] })
    const capacityDispatcher = {
      ...dispatcher,
      onLegacyPtyCapacity: (listener: () => void) => {
        releaseCapacity = listener
        return () => {}
      }
    }
    handler = createTestPtyHandler(capacityDispatcher)
    mockPtySpawn.mockReturnValue({
      ...mockPtyInstance,
      onData: vi.fn((callback: (data: string) => void) => {
        emitData = callback
      })
    })
    await dispatcher.callRequest('pty.spawn', {})
  })

  afterEach(async () => {
    await endPtyHandlerTest(handler, originalPlatform)
  })

  function output(): string[] {
    return dispatcher._notifications
      .filter(({ method }) => method === 'pty.data')
      .map(({ params }) => String(params?.data))
  }

  it('shortens a pending batch when consumer capacity returns', () => {
    emitData('ready')
    vi.advanceTimersByTime(2)
    expect(output()).toEqual([])
    releaseCapacity()
    vi.advanceTimersByTime(0)
    expect(output()).toEqual(['ready'])
  })

  it('does not postpone a batch when later output arrives', () => {
    emitData('first')
    vi.advanceTimersByTime(4)
    emitData('second')
    vi.advanceTimersByTime(3)
    expect(output()).toEqual([])
    vi.advanceTimersByTime(1)
    expect(output()).toEqual(['firstsecond'])
  })

  it('shortens the deadline when multibyte output crosses charged low water', () => {
    emitData('small')
    vi.advanceTimersByTime(2)
    const multibyte = '界'.repeat(22_000)
    emitData(multibyte)
    expect(output()).toEqual([])
    vi.advanceTimersByTime(1)
    expect(output()).toEqual([`small${multibyte}`])
    expect(mockPtyInstance.pause).not.toHaveBeenCalled()
  })

  it('coalesces repeated wakeups and preserves the slice and continuation budgets', () => {
    emitData('x'.repeat(128 * 1024))
    const timersBefore = vi.getTimerCount()
    for (let index = 0; index < 20; index++) {
      releaseCapacity()
    }
    expect(vi.getTimerCount()).toBe(timersBefore)
    vi.advanceTimersByTime(0)
    expect(output()).toEqual(['x'.repeat(64 * 1024)])
    vi.advanceTimersByTime(1)
    expect(output()).toEqual(['x'.repeat(64 * 1024), 'x'.repeat(64 * 1024)])
    vi.advanceTimersByTime(20)
    expect(output()).toHaveLength(2)
  })

  it('cancels a shortened wakeup on disposal', async () => {
    emitData('pending')
    releaseCapacity()
    await handler.dispose({ waitForPhysicalExit: false })
    const countAfterDispose = output().length
    await vi.advanceTimersByTimeAsync(20)
    expect(output()).toHaveLength(countAfterDispose)
    expect(vi.getTimerCount()).toBe(0)
  })
})
