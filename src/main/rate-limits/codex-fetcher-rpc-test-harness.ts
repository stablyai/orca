import { EventEmitter } from 'node:events'
import type { Mock } from 'vitest'
import { vi } from 'vitest'

type TestDisposable = { dispose: Mock<() => void> }

export function makeDisposable(onDispose: () => void = () => undefined): TestDisposable {
  return { dispose: vi.fn(onDispose) }
}

export function makeRpcChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter
    stderr: EventEmitter
    stdin: { write: ReturnType<typeof vi.fn> }
    kill: ReturnType<typeof vi.fn>
  }
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.stdin = { write: vi.fn() }
  child.kill = vi.fn()
  return child
}

export function respondToRpcResult(
  rpcChild: ReturnType<typeof makeRpcChild>,
  result: unknown
): void {
  rpcChild.stdin.write.mockImplementation((line: string) => {
    const message = JSON.parse(line) as { id?: number; method?: string }
    if (message.method === 'initialize') {
      setTimeout(() => {
        rpcChild.stdout.emit(
          'data',
          Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} })}\n`)
        )
      }, 0)
    }
    if (message.method === 'account/rateLimits/read') {
      setTimeout(() => {
        rpcChild.stdout.emit(
          'data',
          Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`)
        )
      }, 0)
    }
  })
}

export function respondToRpcRateLimitRead(
  rpcChild: ReturnType<typeof makeRpcChild>,
  rateLimits: unknown
): void {
  respondToRpcResult(rpcChild, { rateLimits })
}

export function makePtyTerm(): {
  onData: (callback: (data: string) => void) => ReturnType<typeof makeDisposable>
  onExit: (callback: () => void) => ReturnType<typeof makeDisposable>
  write: ReturnType<typeof vi.fn>
  kill: ReturnType<typeof vi.fn>
  emitData: (data: string) => void
  emitExit: () => void
} {
  const dataHandlers = new Set<(data: string) => void>()
  const exitHandlers = new Set<() => void>()
  return {
    onData: vi.fn((callback: (data: string) => void) => {
      dataHandlers.add(callback)
      return makeDisposable(() => {
        dataHandlers.delete(callback)
      })
    }),
    onExit: vi.fn((callback: () => void) => {
      exitHandlers.add(callback)
      return makeDisposable(() => {
        exitHandlers.delete(callback)
      })
    }),
    write: vi.fn(),
    kill: vi.fn(),
    emitData: (data: string) => dataHandlers.forEach((handler) => handler(data)),
    emitExit: () => exitHandlers.forEach((handler) => handler())
  }
}
