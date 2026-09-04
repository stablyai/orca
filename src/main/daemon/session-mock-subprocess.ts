import { vi } from 'vitest'

// Stub the subprocess — Session talks to it via an interface, not child_process directly.
export function createMockSubprocess() {
  const written: string[] = []
  const signals: string[] = []
  let onData: ((data: string) => void) | null = null
  let onExit: ((code: number) => void) | null = null
  let killed = false
  let clearCalls = 0
  let pid = 12345
  let pauseCalls = 0
  let resumeCalls = 0

  return {
    written,
    signals,
    get killed() {
      return killed
    },
    get pid() {
      return pid
    },
    get pauseCalls() {
      return pauseCalls
    },
    get resumeCalls() {
      return resumeCalls
    },
    foregroundProcess: null as string | null,
    getForegroundProcess(): string | null {
      return this.foregroundProcess
    },
    confirmShellForeground: vi.fn(async () => true),
    write(data: string) {
      written.push(data)
    },
    resize(_cols: number, _rows: number) {},
    pause() {
      pauseCalls++
    },
    resume() {
      resumeCalls++
    },
    get clearCalls() {
      return clearCalls
    },
    clear() {
      clearCalls++
    },
    kill() {
      killed = true
      // Simulate async exit
      setTimeout(() => onExit?.(0), 5)
    },
    terminateOwnedTree: () => 'terminated' as const,
    forceKill() {
      killed = true
    },
    signal(sig: string) {
      signals.push(sig)
    },
    onData(cb: (data: string) => void) {
      onData = cb
    },
    onExit(cb: (code: number) => void) {
      onExit = cb
    },
    dispose() {},
    // Helpers for tests to simulate subprocess events
    simulateData(data: string) {
      onData?.(data)
    },
    simulateExit(code: number) {
      onExit?.(code)
    }
  }
}

export type MockSubprocess = ReturnType<typeof createMockSubprocess>
