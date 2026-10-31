import { vi } from 'vitest'

export function createMockSubprocess() {
  const written: string[] = []
  const signals: string[] = []
  let onData: ((data: string) => void) | null = null
  let onExit: ((code: number) => void) | null = null
  let killed = false
  let pauseCalls = 0
  let resumeCalls = 0

  return {
    written,
    signals,
    get killed() {
      return killed
    },
    get pid() {
      return 12345
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
    clear() {},
    kill() {
      killed = true
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
    simulateData(data: string) {
      onData?.(data)
    },
    simulateExit(code: number) {
      onExit?.(code)
    }
  }
}
