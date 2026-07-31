import { EventEmitter } from 'node:events'
import { vi } from 'vitest'

export function makeDisposable(): { dispose: ReturnType<typeof vi.fn> } {
  return { dispose: vi.fn() }
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
  onData: ReturnType<typeof vi.fn>
  onExit: ReturnType<typeof vi.fn>
  write: ReturnType<typeof vi.fn>
  kill: ReturnType<typeof vi.fn>
  emitData: (data: string) => void
  emitExit: () => void
} {
  let dataHandler: ((data: string) => void) | null = null
  let exitHandler: (() => void) | null = null
  return {
    onData: vi.fn((callback: (data: string) => void) => {
      dataHandler = callback
      return makeDisposable()
    }),
    onExit: vi.fn((callback: () => void) => {
      exitHandler = callback
      return makeDisposable()
    }),
    write: vi.fn(),
    kill: vi.fn(),
    emitData: (data: string) => dataHandler?.(data),
    emitExit: () => exitHandler?.()
  }
}
