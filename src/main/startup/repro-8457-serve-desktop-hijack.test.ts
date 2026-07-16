/**
 * Issue #8457 — headless serve hijacks GUI relaunch; forced reopen can
 * interrupt/duplicate live agents.
 *
 * Serve mode acquires the single-instance lock and, after settle with a
 * daemon-backed PTY provider, marks the activation gate `ready`. Second-instance
 * / Dock activate then call openMainWindow inside the headless process.
 * `orca open` only fails closed on `blocked`, not on headless `openable`.
 *
 * Re-run:
 *   pnpm exec vitest run --config config/vitest.config.ts \
 *     src/main/startup/repro-8457-serve-desktop-hijack.test.ts
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createServeDesktopActivationGate } from './serve-desktop-activation'
import { shouldSkipSingleInstanceLock } from './single-instance-lock'

/** Mirrors settleServeDesktopActivation in src/main/index.ts. */
function settleServeDesktopActivation(
  gate: ReturnType<typeof createServeDesktopActivationGate>,
  isFallbackLocalPtyProvider: boolean
): void {
  if (isFallbackLocalPtyProvider) {
    gate.markBlocked('persistent PTY provider unavailable')
    return
  }
  gate.markReady()
}

/** Mirrors RuntimeClient.openOrca early-exit policy. */
function openOrcaShouldFailClosed(
  desktopWindowStatus: 'available' | 'openable' | 'initializing' | 'blocked' | undefined
): boolean {
  return desktopWindowStatus === 'blocked'
}

describe('issue #8457 headless serve hijacks desktop activation', () => {
  it('packaged serve does not skip the single-instance lock (becomes lock owner)', () => {
    // Dev non-serve skips the lock; serve never does — headless can own the profile.
    expect(shouldSkipSingleInstanceLock({ isDev: false, isServeMode: true })).toBe(false)
    expect(shouldSkipSingleInstanceLock({ isDev: true, isServeMode: true })).toBe(false)
    expect(shouldSkipSingleInstanceLock({ isDev: true, isServeMode: false })).toBe(true)
  })

  it('after settle with daemon PTY, second-instance activation opens the desktop window', () => {
    const activateWindow = vi.fn()
    const onBlocked = vi.fn()
    const gate = createServeDesktopActivationGate({
      initialState: 'initializing',
      activateWindow,
      onBlocked
    })

    // Second-instance / open -n while serve is still starting.
    gate.requestActivation()
    expect(activateWindow).not.toHaveBeenCalled()

    // Daemon-backed persistent sessions → markReady (not blocked).
    settleServeDesktopActivation(gate, /* isFallbackLocalPtyProvider */ false)

    // Pending activation drains into openMainWindow (via activateWindow).
    expect(activateWindow).toHaveBeenCalledOnce()
    expect(gate.getState()).toBe('ready')
    expect(onBlocked).not.toHaveBeenCalled()

    // Later Dock / open -a / second-instance also open the window.
    gate.requestActivation()
    expect(activateWindow).toHaveBeenCalledTimes(2)
  })

  it('only blocks open when provider is the non-persistent LocalPty fallback', () => {
    const activateWindow = vi.fn()
    const onBlocked = vi.fn()
    const gate = createServeDesktopActivationGate({
      initialState: 'initializing',
      activateWindow,
      onBlocked
    })
    gate.requestActivation()
    settleServeDesktopActivation(gate, /* isFallbackLocalPtyProvider */ true)
    expect(activateWindow).not.toHaveBeenCalled()
    expect(gate.getState()).toBe('blocked')
    expect(onBlocked).toHaveBeenCalled()
  })

  it('orca open fails closed only for blocked — openable headless still launches', () => {
    // Headless serve with daemon PTYs reports openable after settle, not blocked.
    expect(openOrcaShouldFailClosed('blocked')).toBe(true)
    expect(openOrcaShouldFailClosed('openable')).toBe(false)
    expect(openOrcaShouldFailClosed('initializing')).toBe(false)
    expect(openOrcaShouldFailClosed('available')).toBe(false)
  })

  it('wiring still routes serve activation to openMainWindow after markReady', () => {
    const indexSrc = readFileSync(join(process.cwd(), 'src/main/index.ts'), 'utf8')
    expect(indexSrc).toMatch(/initialState: isServeMode \? 'initializing' : 'ready'/)
    expect(indexSrc).toMatch(/activateWindow: \(\) => \{[\s\S]*focusExistingWindow\(\)/)
    expect(indexSrc).toMatch(/settleServeDesktopActivation\(\)/)
    // Daemon path marks ready → allows promotion; only LocalPtyProvider blocks.
    expect(indexSrc).toMatch(/getLocalPtyProvider\(\) instanceof LocalPtyProvider/)
    expect(indexSrc).toMatch(/desktopActivationGate\.markReady\(\)/)
    expect(indexSrc).toMatch(/desktopActivationGate\.markBlocked\(/)
    // focusExistingMainWindow still opens a window when none exists.
    const focusSrc = readFileSync(
      join(process.cwd(), 'src/main/window/focus-existing-window.ts'),
      'utf8'
    )
    expect(focusSrc).toMatch(/window = opts\.openWindow\(\)/)
  })
})
