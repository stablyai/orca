import { vi } from 'vitest'
import type { SubprocessHandle } from '../../sessions/session-subprocess-handle'
import type { TerminalExitCause } from '../../../../shared/terminal/pty/lifecycle/terminal-exit-cause'

export function createMockSubprocess(): SubprocessHandle & {
  write: ReturnType<typeof vi.fn<(data: string) => void>>
  pause: ReturnType<typeof vi.fn<() => void>>
  resume: ReturnType<typeof vi.fn<() => void>>
  confirmShellForeground: ReturnType<typeof vi.fn<() => Promise<boolean>>>
  _simulateData: (data: string) => void
  _simulateExit: (code: number, cause?: TerminalExitCause) => void
} {
  let onDataCb: ((data: string) => void) | null = null
  let onExitCb: ((code: number, cause?: TerminalExitCause) => void) | null = null
  return {
    // getCwd falls back to OS lookup; keep the fake PID outside the real process range.
    pid: 999_999_999,
    getForegroundProcess: vi.fn(() => null),
    confirmShellForeground: vi.fn(async () => false),
    write: vi.fn(),
    resize: vi.fn(),
    pause: vi.fn<() => void>(),
    resume: vi.fn<() => void>(),
    kill: vi.fn(() => onExitCb?.(0)),
    terminateOwnedTree: () => 'unavailable' as const,
    forceKill: vi.fn(() => {
      onExitCb?.(137)
    }),
    signal: vi.fn(),
    onData(cb) {
      onDataCb = cb
    },
    onExit(cb) {
      onExitCb = cb
    },
    dispose: vi.fn(),
    _simulateData(data: string) {
      onDataCb?.(data)
    },
    _simulateExit(code: number, cause?: TerminalExitCause) {
      onExitCb?.(code, cause)
    }
  }
}
