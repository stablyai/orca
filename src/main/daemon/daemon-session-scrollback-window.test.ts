/**
 * OOM regression: a daemon owning 100+ terminals retained ~5000 rows of grid per session with no
 * bound, grew to ~1.9 GB, and was killed under system memory pressure — losing every session it
 * owned. Sessions now retain a flat window; deep scrolling on an open terminal is the renderer's
 * live buffer, and the window is what a rebuild (reload/remount/restart/remote attach) restores.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TerminalHost } from './terminal-host'
import type { SubprocessHandle } from './session'
import {
  DAEMON_SESSION_SCROLLBACK_ROWS,
  resolveDaemonSessionScrollbackRows
} from './daemon-session-scrollback-window'

describe('resolveDaemonSessionScrollbackRows', () => {
  it('defaults to the flat window', () => {
    expect(resolveDaemonSessionScrollbackRows({} as NodeJS.ProcessEnv)).toBe(
      DAEMON_SESSION_SCROLLBACK_ROWS
    )
  })

  it('accepts the inclusive override bounds and rejects everything outside them', () => {
    for (const raw of ['100', '2500', '5000']) {
      const env = { ORCA_DAEMON_SESSION_SCROLLBACK_ROWS: raw } as NodeJS.ProcessEnv
      expect(resolveDaemonSessionScrollbackRows(env)).toBe(Number(raw))
    }
    // Why bounded: 0 loses the visible screen's context; huge values silently reintroduce the
    // unbounded retention this window exists to prevent.
    for (const raw of ['0', '50', '99', '5001', '50000', '-1', '3.5', 'nonsense', '']) {
      const env = { ORCA_DAEMON_SESSION_SCROLLBACK_ROWS: raw } as NodeJS.ProcessEnv
      expect(resolveDaemonSessionScrollbackRows(env)).toBe(DAEMON_SESSION_SCROLLBACK_ROWS)
    }
  })
})

describe('daemon session scrollback window', () => {
  let host: TerminalHost
  let dataCb: ((data: string) => void) | null

  function createMockSubprocess(): SubprocessHandle {
    let onExitCb: ((code: number) => void) | null = null
    return {
      pid: 4242,
      getForegroundProcess: vi.fn(() => null),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(() => {
        setTimeout(() => onExitCb?.(0), 1)
      }),
      forceKill: vi.fn(() => onExitCb?.(137)),
      signal: vi.fn(),
      onData(cb) {
        dataCb = cb
      },
      onExit(cb) {
        onExitCb = cb
      },
      dispose: vi.fn()
    } as SubprocessHandle
  }

  beforeEach(() => {
    dataCb = null
    host = new TerminalHost({ spawnSubprocess: () => createMockSubprocess() })
  })

  afterEach(async () => {
    await host.dispose()
  })

  it('caps retained rows at the window while keeping the newest content', async () => {
    await host.createOrAttach({
      sessionId: 'windowed',
      cols: 80,
      rows: 24,
      streamClient: { onData: vi.fn(), onExit: vi.fn() }
    })
    const total = DAEMON_SESSION_SCROLLBACK_ROWS + 500
    for (let i = 1; i <= total; i += 1) {
      dataCb?.(`LINE_${String(i).padStart(5, '0')}\r\n`)
    }
    await vi.waitFor(() => {
      const snapshot = host.getSnapshot('windowed')
      expect(snapshot?.snapshotAnsi ?? snapshot?.scrollbackAnsi).toBeTruthy()
      const text = `${snapshot?.scrollbackAnsi ?? ''}${snapshot?.snapshotAnsi ?? ''}`
      // Newest line always present; the oldest has scrolled past the window.
      expect(text).toContain(`LINE_${String(total).padStart(5, '0')}`)
      expect(text).not.toContain('LINE_00001')
      const retainedMatches = text.match(/LINE_\d{5}/g) ?? []
      expect(retainedMatches.length).toBeLessThanOrEqual(DAEMON_SESSION_SCROLLBACK_ROWS + 24)
      expect(retainedMatches.length).toBeGreaterThan(DAEMON_SESSION_SCROLLBACK_ROWS - 50)
    })
  })
})
