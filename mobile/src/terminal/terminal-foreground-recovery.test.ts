import { readFileSync } from 'node:fs'
import type { RefObject } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { ConnectionState } from '../transport/types'
import type { TerminalWebViewHandle } from './TerminalWebView'
import {
  TERMINAL_FOREGROUND_RECOVERY_DELAY_MS,
  recoverActiveTerminalAfterForeground,
  shouldRecoverTerminalOnAppStateChange
} from './terminal-foreground-recovery'

const sessionSource = readFileSync(
  new URL('../../app/h/[hostId]/session/[worktreeId].tsx', import.meta.url),
  'utf8'
)

function sliceSessionSource(startPattern: string, endPattern: string): string {
  const start = sessionSource.indexOf(startPattern)
  expect(start).toBeGreaterThanOrEqual(0)
  const end = sessionSource.indexOf(endPattern, start)
  expect(end).toBeGreaterThan(start)
  return sessionSource.slice(start, end)
}

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

function createHarness(): RecoveryHarness {
  const scheduled: Array<() => void> = []
  return {
    activeHandleRef: { current: 'term-1' },
    terminalRefs: {
      current: new Map([['term-1', {} as TerminalWebViewHandle]])
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

  it('forces an initialized active terminal to replay scrollback after foregrounding', () => {
    const harness = createHarness()

    const recovered = recoverActiveTerminalAfterForeground(harness)

    expect(recovered).toBe(true)
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
    harness.terminalRefs.current.set('term-2', {} as TerminalWebViewHandle)
    harness.initializedHandlesRef.current.add('term-2')

    const recovered = recoverActiveTerminalAfterForeground(harness)

    expect(recovered).toBe(true)
    expect(harness.initializedHandlesRef.current.has('term-1')).toBe(false)
    expect(harness.initializedHandlesRef.current.has('term-2')).toBe(false)
    expect(harness.unsubscribeTerminal).toHaveBeenCalledWith('term-1')
  })

  it('does not churn subscriptions when there is no initialized active terminal', () => {
    const harness = createHarness()
    harness.initializedHandlesRef.current.clear()

    const recovered = recoverActiveTerminalAfterForeground(harness)

    expect(recovered).toBe(false)
    expect(harness.unsubscribeTerminal).not.toHaveBeenCalled()
    expect(harness.schedule).not.toHaveBeenCalled()
  })

  it('does not replay a stale terminal if focus changes before the delayed subscribe', () => {
    const harness = createHarness()

    recoverActiveTerminalAfterForeground(harness)
    harness.activeHandleRef.current = 'term-2'
    harness.runScheduled()

    expect(harness.subscribeToTerminal).not.toHaveBeenCalled()
  })

  it('is wired to AppState foregrounding in the session screen', () => {
    const foregroundPredicate = sliceSessionSource(
      'const shouldRecover = shouldRecoverTerminalOnAppStateChange(',
      'previousAppState = nextAppState'
    )

    expect(sessionSource).toContain('shouldRecoverTerminalOnAppStateChange')
    expect(foregroundPredicate).toContain('Platform.OS')
    expect(sessionSource).toContain('recoverActiveTerminalAfterForeground({')
    expect(sessionSource).toContain("AppState.addEventListener('change'")
  })
})
