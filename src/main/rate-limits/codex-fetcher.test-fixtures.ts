import { EventEmitter } from 'node:events'
import { vi } from 'vitest'

type MockFn = ReturnType<typeof vi.fn>

export type FakeRpcChild = EventEmitter & {
  stdout: EventEmitter
  stderr: EventEmitter
  stdin: EventEmitter & { write: MockFn; end: MockFn }
  kill: MockFn
  exitCode: number | null
}

export function makeRpcChild(): FakeRpcChild {
  const child: FakeRpcChild = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    stdin: Object.assign(new EventEmitter(), { write: vi.fn(), end: vi.fn() }),
    kill: vi.fn(),
    exitCode: null
  })
  // Why: the fake must report exit when the graceful shutdown closes stdin or sends a signal.
  const exitNow = (): void => {
    child.exitCode = 0
    child.emit('exit', 0, null)
    child.emit('close', 0, null)
  }
  child.stdin.end.mockImplementation(exitNow)
  child.kill.mockImplementation(() => {
    exitNow()
    return true
  })
  return child
}
