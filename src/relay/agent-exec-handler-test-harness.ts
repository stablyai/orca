import { EventEmitter } from 'events'
import { vi } from 'vitest'
import type { MethodHandler, RequestContext } from './dispatcher'
import { AgentExecHandler } from './agent-exec-handler'

function hasFinally(value: unknown): value is Promise<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'finally' in value &&
    typeof value.finally === 'function'
  )
}

export function withPlatform<T>(platform: NodeJS.Platform, fn: () => T): T {
  const original = process.platform
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
  let restoreImmediately = true
  const restore = (): void => {
    Object.defineProperty(process, 'platform', { configurable: true, value: original })
  }
  try {
    const result = fn()
    if (hasFinally(result)) {
      restoreImmediately = false
      return result.finally(restore) as T
    }
    restore()
    return result
  } finally {
    if (restoreImmediately && process.platform === platform) {
      restore()
    }
  }
}

export type FakeChild = EventEmitter & {
  pid: number
  kill: ReturnType<typeof vi.fn>
  stdout: EventEmitter
  stderr: EventEmitter
  stdin: { end: ReturnType<typeof vi.fn> }
}

export function createFakeChild(): FakeChild {
  return Object.assign(new EventEmitter(), {
    pid: 12345,
    kill: vi.fn(),
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    stdin: { end: vi.fn() }
  })
}

export function createHandlers(): Map<string, MethodHandler> {
  const handlers = new Map<string, MethodHandler>()
  new AgentExecHandler({
    onRequest: (method: string, handler: MethodHandler): void => {
      handlers.set(method, handler)
    }
  } as never)
  return handlers
}

export function requestContext(clientId = 1): RequestContext {
  return { clientId, isStale: () => false }
}
