import { vi } from 'vitest'

export function makeDisposable() {
  return { dispose: vi.fn<() => void>() }
}

export function makePtyTerm() {
  let dataHandler: ((data: string) => void) | null = null
  let exitHandler: (() => void) | null = null
  return {
    onData: vi.fn((callback: (data: string) => void) => {
      dataHandler = callback
      return makeDisposable()
    }),
    onError: vi.fn(() => ({ dispose: vi.fn<() => void>() })),
    onExit: vi.fn((callback: () => void) => {
      exitHandler = callback
      return makeDisposable()
    }),
    write: vi.fn<(data: string) => void>(),
    kill: vi.fn<() => void>(),
    emitData: (data: string) => dataHandler?.(data),
    emitExit: () => exitHandler?.()
  }
}

