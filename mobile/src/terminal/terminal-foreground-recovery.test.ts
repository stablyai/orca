import type { RefObject } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { ConnectionState } from '../transport/types'
import type { TerminalWebViewHandle } from './TerminalWebView'
import {
  TERMINAL_FOREGROUND_RECOVERY_DELAY_MS,
  recoverActiveTerminalAfterForeground,
  shouldRecoverTerminalOnAppStateChange
} from './terminal-foreground-recovery'

type RecoveryHarness = {
  activeHandleRef: RefObject<string | null>
  terminalRefs: RefObject<Map<string, TerminalWebViewHandle>>
  initializedHandlesRef: RefObject<Set<string>>
  connStateRef: RefObject<ConnectionState>
  unsubscribeTerminal: ReturnType<typeof vi.fn<(handle: string) => void>>
  subscribeToTerminal: ReturnType<typeof vi.fn<(handle: string) => void>>
  schedule: ReturnType<typeof vi.fn<(fn: () => void, ms: number) => void>>
  runScheduled: () => void
}

function terminalHandle(): TerminalWebViewHandle {
  return {
    prepareForForegroundRecovery: vi.fn(),
    write: vi.fn(),
    init: vi.fn(),
    resize: vi.fn(),
    reflow: vi.fn(),
    clear: vi.fn(),
    fitDimensions: vi.fn(() => null),
    scrollToBottom: vi.fn(),
    resetZoom: vi.fn(),
    cancelSelect: vi.fn(),
    doSelectAll: vi.fn(),
    awaitReady: vi.fn(async () => {})
  }
}

function createHarness(): RecoveryHarness {
  const scheduled: Array<() => void> = []
  return {
    activeHandleRef: { current: 'term-1' },
    terminalRefs: {
      current: new Map([['term-1', terminalHandle()]])
    },
    initializedHandlesRef: { current: new Set(['term-1']) },
    connStateRef: { current: 'connected' },
    unsubscribeTerminal: vi.fn(),
    subscribeToTerminal: vi.fn(),
    schedule: vi.fn((fn: () => void) => {
      scheduled.push(fn)
    }),
    runScheduled: () => {
      for (const fn of scheduled.splice(0)) {
        fn()
      }
    }
  }
}

describe('terminal foreground recovery', () => {
  it('detects iOS foreground transitions after backgrounding or inactive states', () => {
    expect(shouldRecoverTerminalOnAppStateChange('background', 'active', 'ios')).toBe(true)
    expect(shouldRecoverTerminalOnAppStateChange('inactive', 'active', 'ios')).toBe(true)
    expect(shouldRecoverTerminalOnAppStateChange('active', 'active', 'ios')).toBe(false)
    expect(shouldRecoverTerminalOnAppStateChange('active', 'background', 'ios')).toBe(false)
    expect(shouldRecoverTerminalOnAppStateChange('background', 'active', 'android')).toBe(false)
  })

  it('retires an initialized active subscription and schedules its replacement', () => {
    const harness = createHarness()

    const recovered = recoverActiveTerminalAfterForeground(harness)

    expect(recovered).toBe('recovered')
    expect(harness.unsubscribeTerminal).toHaveBeenCalledWith('term-1')
    expect(harness.initializedHandlesRef.current.has('term-1')).toBe(false)
    expect(harness.schedule).toHaveBeenCalledWith(
      expect.any(Function),
      TERMINAL_FOREGROUND_RECOVERY_DELAY_MS
    )
    expect(harness.subscribeToTerminal).not.toHaveBeenCalled()

    harness.runScheduled()

    expect(harness.subscribeToTerminal).toHaveBeenCalledWith('term-1')
  })

  it('marks inactive mounted terminal buffers stale so their next activation can replay', () => {
    const harness = createHarness()
    harness.terminalRefs.current.set('term-2', terminalHandle())
    harness.initializedHandlesRef.current.add('term-2')

    const recovered = recoverActiveTerminalAfterForeground(harness)

    expect(recovered).toBe('recovered')
    expect(harness.initializedHandlesRef.current.has('term-1')).toBe(false)
    expect(harness.initializedHandlesRef.current.has('term-2')).toBe(false)
    expect(harness.unsubscribeTerminal).toHaveBeenCalledWith('term-1')
  })

  it('does not churn subscriptions when there is no initialized active terminal', () => {
    const harness = createHarness()
    harness.initializedHandlesRef.current.clear()

    const recovered = recoverActiveTerminalAfterForeground(harness)

    expect(recovered).toBe('skipped')
    expect(harness.unsubscribeTerminal).not.toHaveBeenCalled()
    expect(harness.schedule).not.toHaveBeenCalled()
  })

  it('defers without touching state when the socket is not connected yet', () => {
    const harness = createHarness()
    harness.connStateRef.current = 'reconnecting'

    const recovered = recoverActiveTerminalAfterForeground(harness)

    expect(recovered).toBe('deferred')
    // Deferred recovery must retain initialization state so reconnect can force fresh scrollback.
    expect(harness.initializedHandlesRef.current.has('term-1')).toBe(true)
    expect(harness.unsubscribeTerminal).not.toHaveBeenCalled()
    expect(harness.schedule).not.toHaveBeenCalled()
  })

  it('resubscribes when re-run after a deferred reconnect completes', () => {
    const harness = createHarness()
    harness.connStateRef.current = 'reconnecting'

    expect(recoverActiveTerminalAfterForeground(harness)).toBe('deferred')

    harness.connStateRef.current = 'connected'
    expect(recoverActiveTerminalAfterForeground(harness)).toBe('recovered')
    harness.runScheduled()
    expect(harness.subscribeToTerminal).toHaveBeenCalledWith('term-1')
  })

  it('does not replay a stale terminal if focus changes before the delayed subscribe', () => {
    const harness = createHarness()

    recoverActiveTerminalAfterForeground(harness)
    harness.activeHandleRef.current = 'term-2'
    harness.runScheduled()

    expect(harness.subscribeToTerminal).not.toHaveBeenCalled()
  })
})
