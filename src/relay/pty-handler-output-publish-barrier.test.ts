import './mock-descendant-sweep'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

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

vi.mock('node-pty', () => ({
  spawn: mockPtySpawn
}))

vi.mock('../main/pty/posix-pty-process-groups', () => ({
  forceKillPosixPtyProcessGroups: vi.fn((_pid: number, fallback: () => void) => fallback())
}))

vi.mock('../main/shell-prompt-readiness-probe', () => ({
  createShellPromptReadinessProbe: mockCreateShellPromptReadinessProbe
}))

import type { PtyHandler } from './pty-handler'
import { beginPtyHandlerTest, endPtyHandlerTest, testPtyId } from './pty-handler-test-harness'
import type { MockDispatcher } from './pty-handler-test-harness'

// The blocking hook POST used to put an agent's event on the wire before the agent could print or
// exit. With committed hooks, the relay drains through this barrier to keep that order.
describe('PtyHandler output publish barrier', () => {
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

  function spawnCallbacks() {
    const callbacks: {
      onData?: (data: string) => void
      onExit?: (evt: { exitCode: number }) => void
    } = {}
    mockPtySpawn.mockReturnValue({
      ...mockPtyInstance,
      onData: vi.fn((cb: (data: string) => void) => {
        callbacks.onData = cb
      }),
      onExit: vi.fn((cb: (evt: { exitCode: number }) => void) => {
        callbacks.onExit = cb
      })
    })
    return callbacks
  }

  function recordWire(): string[] {
    const wire: string[] = []
    handler.setOutputPublishBarrier(() => {
      wire.push('barrier')
    })
    dispatcher.notify.mockImplementation((method: string) => {
      if (method === 'pty.data' || method === 'pty.exit') {
        wire.push(method)
      }
    })
    return wire
  }

  it('runs before every output chunk and before the exit', async () => {
    const pty = spawnCallbacks()
    const wire = recordWire()
    await dispatcher.callRequest('pty.spawn', {})

    pty.onData!('working')
    vi.advanceTimersByTime(8)
    pty.onData!('title reverted to the shell')
    pty.onExit!({ exitCode: 0 })

    expect(wire).toEqual(['barrier', 'pty.data', 'barrier', 'pty.data', 'barrier', 'pty.exit'])
  })

  it('runs before output sent straight back after a keypress', async () => {
    const pty = spawnCallbacks()
    const wire = recordWire()
    await dispatcher.callRequest('pty.spawn', {})

    dispatcher.callNotification('pty.data', { id: testPtyId(1), data: '\x1b' })
    pty.onData!('\x1b]0;zsh\x07$ ')
    vi.advanceTimersByTime(8)

    expect(wire).toEqual(['barrier', 'pty.data'])
  })
})
