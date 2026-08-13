import { EventEmitter } from 'node:events'
import { vi } from 'vitest'
import type { MethodHandler, RequestContext } from './dispatcher'
import { AgentExecHandler } from './agent-exec-handler'

export function withPlatform<T>(platform: NodeJS.Platform, fn: () => T): T {
  const original = process.platform
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
  try {
    return fn()
  } finally {
    Object.defineProperty(process, 'platform', { configurable: true, value: original })
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

const INHERITED_GIT_CONFIG_RE = /^GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+)$/

/**
 * Drops the shell's indexed Git-config protocol for one test, returning a
 * restore callback. Assertions that baseline on `...process.env` otherwise
 * depend on the caller's shell: an inherited `GIT_CONFIG_COUNT` makes the
 * credential guard append at a later index than the test asserts.
 */
export function clearInheritedGitConfigEnv(): () => void {
  const saved = Object.entries(process.env).filter(
    (entry): entry is [string, string] =>
      INHERITED_GIT_CONFIG_RE.test(entry[0]) && typeof entry[1] === 'string'
  )
  for (const [key] of saved) {
    delete process.env[key]
  }
  return () => {
    for (const [key, value] of saved) {
      process.env[key] = value
    }
  }
}
