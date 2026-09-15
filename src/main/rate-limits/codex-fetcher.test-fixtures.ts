/**
 * Shared fakes for the Codex probe suites.
 *
 * Why a fixture module: `codex-fetcher.test.ts` is at the max-lines ceiling, so a suite that needs
 * the same probe doubles lives in its own file and imports them instead of growing that one.
 *
 * Why the explicit annotations: exporting a function forces TypeScript to name its return type, and
 * an inferred `vi.fn()` type reaches into vitest internals (`TS2883`). Writing it via
 * `ReturnType<typeof vi.fn>` keeps it nameable.
 */
import { EventEmitter } from 'node:events'
import { vi } from 'vitest'

type MockFn = ReturnType<typeof vi.fn>

export type FakeDisposable = { dispose: MockFn }

export type FakePtyTerm = {
  onData: (callback: (data: string) => void) => FakeDisposable
  onExit: (callback: () => void) => FakeDisposable
  write: MockFn
  kill: MockFn
  emitData: (data: string) => void
  emitExit: () => void
}

export function makeDisposable(): FakeDisposable {
  return { dispose: vi.fn() }
}

export function makeRpcChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter
    stderr: EventEmitter
    stdin: EventEmitter & { write: MockFn; end: MockFn }
    kill: MockFn
    exitCode: number | null
  }
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  // Why: like the real app-server, the fake dies on stdin EOF or a signal —
  // the graceful shutdown path resolves only once the child reports exit.
  const exitNow = (): void => {
    child.exitCode = 0
    child.emit('exit', 0, null)
    child.emit('close', 0, null)
  }
  child.stdin = Object.assign(new EventEmitter(), { write: vi.fn(), end: vi.fn(exitNow) })
  child.exitCode = null
  child.kill = vi.fn(() => {
    exitNow()
    return true
  })
  return child
}

export function respondToRpcRateLimitRead(
  rpcChild: ReturnType<typeof makeRpcChild>,
  rateLimits: unknown
): void {
  rpcChild.stdin.write.mockImplementation((line: string) => {
    const msg = JSON.parse(line) as { id?: number; method?: string }
    if (msg.method === 'initialize') {
      setTimeout(() => {
        rpcChild.stdout.emit(
          'data',
          Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} })}\n`)
        )
      }, 0)
    }
    if (msg.method === 'account/rateLimits/read') {
      setTimeout(() => {
        rpcChild.stdout.emit(
          'data',
          Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { rateLimits } })}\n`)
        )
      }, 0)
    }
  })
}

export function makePtyTerm(): FakePtyTerm {
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
