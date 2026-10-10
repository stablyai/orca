/**
 * OOM regression twin of daemon-session-scrollback-window.test.ts: the runtime's
 * per-PTY headless mirror used the unbounded emulator default while the daemon
 * had already been OOM-killed at full depth. Unlike the daemon twin, this
 * mirror also feeds desktop hidden-output recovery (serializeHiddenOutputRecoveryBuffer
 * serves parked-pane reveals at the user's configured depth), so the default
 * must cover the desktop default rather than truncate it.
 */
import { describe, expect, it } from 'vitest'
import { HeadlessEmulator } from '../daemon/headless-emulator'
import { DESKTOP_TERMINAL_SCROLLBACK_ROWS_DEFAULT } from '../../shared/terminal-scrollback-policy'
import {
  resolveRuntimeSessionScrollbackRows,
  RUNTIME_SESSION_SCROLLBACK_ROWS
} from './runtime-session-scrollback-window'

describe('resolveRuntimeSessionScrollbackRows', () => {
  it('defaults to the flat window', () => {
    expect(resolveRuntimeSessionScrollbackRows({} as NodeJS.ProcessEnv)).toBe(
      RUNTIME_SESSION_SCROLLBACK_ROWS
    )
  })

  it('covers the desktop hidden-output recovery depth by default', () => {
    // Capping below the desktop default would silently truncate parked-pane
    // reveals from the configured depth to the mirror's window.
    expect(RUNTIME_SESSION_SCROLLBACK_ROWS).toBe(DESKTOP_TERMINAL_SCROLLBACK_ROWS_DEFAULT)
  })

  it('accepts the inclusive override bounds and rejects everything outside them', () => {
    for (const raw of ['100', '2500', '5000']) {
      const env = { ORCA_RUNTIME_SESSION_SCROLLBACK_ROWS: raw } as NodeJS.ProcessEnv
      expect(resolveRuntimeSessionScrollbackRows(env)).toBe(Number(raw))
    }
    // Why bounded: 0 loses the visible screen's context; huge values silently
    // reintroduce the unbounded retention this window exists to prevent.
    for (const raw of ['0', '99', '5001', '50000', '-1', '3.5', 'nonsense', '']) {
      const env = { ORCA_RUNTIME_SESSION_SCROLLBACK_ROWS: raw } as NodeJS.ProcessEnv
      expect(resolveRuntimeSessionScrollbackRows(env)).toBe(RUNTIME_SESSION_SCROLLBACK_ROWS)
    }
  })
})

describe('runtime headless emulator scrollback window', () => {
  it('retains only the window of rows while keeping the newest content', async () => {
    const emulator = new HeadlessEmulator({
      cols: 80,
      rows: 24,
      scrollback: resolveRuntimeSessionScrollbackRows({} as NodeJS.ProcessEnv)
    })
    try {
      const total = RUNTIME_SESSION_SCROLLBACK_ROWS + 500
      await emulator.write(
        Array.from(
          { length: total },
          (_, index) => `LINE_${String(index + 1).padStart(5, '0')}\r\n`
        ).join('')
      )
      const snapshot = emulator.getSnapshot()
      const text = `${snapshot.scrollbackAnsi ?? ''}${snapshot.snapshotAnsi ?? ''}`
      // Newest line always present; the oldest has scrolled past the window.
      expect(text).toContain(`LINE_${String(total).padStart(5, '0')}`)
      expect(text).not.toContain('LINE_00001')
      // Daemon-twin bounds: catch a future drift in the resolved window, not
      // just the two endpoints.
      const retainedMatches = text.match(/LINE_\d{5}/g) ?? []
      expect(retainedMatches.length).toBeLessThanOrEqual(RUNTIME_SESSION_SCROLLBACK_ROWS + 24)
      expect(retainedMatches.length).toBeGreaterThan(RUNTIME_SESSION_SCROLLBACK_ROWS - 50)
    } finally {
      emulator.dispose()
    }
  })
})
