import { createContext, runInContext } from 'node:vm'
// TypeScript 7 is a native CLI; transpile tests still need the legacy JavaScript API.
import ts from 'typescript-api'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  PI_BACKGROUND_WORK_STATUS_KEY,
  getPiBackgroundWorkBridgeSource
} from './rpc-background-work-bridge-source'

const REGISTRY_KEY = '@agegr/pi-web/session-liveness/v1'
type Handler = (event: unknown, ctx: unknown) => void
type Registry = {
  register: (provider: Record<string, unknown>) => () => void
}

function isRegistry(value: unknown): value is Registry {
  return (
    typeof value === 'object' &&
    value !== null &&
    'register' in value &&
    typeof value.register === 'function'
  )
}

/** One Pi process: a realm whose globalThis outlives extension reloads, as Pi's does. */
function piProcess() {
  const output = ts.transpileModule(getPiBackgroundWorkBridgeSource(), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
  }).outputText
  const exports: { default?: unknown } = {}
  const realm = createContext({ setInterval, clearInterval, exports })
  const reports: (string | undefined)[] = []
  const loadBridge = () => {
    runInContext(`(function () {\n${output}\n})()`, realm)
    const handlers = new Map<string, Handler>()
    const factory = exports.default
    if (typeof factory !== 'function') {
      throw new Error('the bridge has no default export')
    }
    factory({ on: (name: string, handler: Handler) => handlers.set(name, handler) })
    return handlers
  }
  const ctx = (sessionId: string) => ({
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionFile: () => `/s/${sessionId}.jsonl`
    },
    ui: {
      setStatus: (key: string, text: string | undefined) => {
        if (key === PI_BACKGROUND_WORK_STATUS_KEY) {
          reports.push(text)
        }
      }
    }
  })
  // pi-subagents 0.84.0 looks the registry up in its own session_start (pi-web-session-liveness.js).
  const registry = (): Registry => {
    const value: unknown = runInContext(
      `globalThis[Symbol.for(${JSON.stringify(REGISTRY_KEY)})]`,
      realm
    )
    if (!isRegistry(value)) {
      throw new Error('the bridge installed no registry')
    }
    return value
  }
  return { loadBridge, ctx, reports, registry }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('the Pi background-work bridge', () => {
  it('reports a provider that registers after load until it goes idle or is released', () => {
    const pi = piProcess()
    const bridge = pi.loadBridge()
    let running = true
    const release = pi.registry().register({
      name: 'pi-subagents',
      sessionId: 'a',
      isActive: () => running
    })
    bridge.get('session_start')!({}, pi.ctx('a'))
    expect(pi.reports).toEqual(['active'])

    running = false
    vi.advanceTimersByTime(5_000)
    running = true
    vi.advanceTimersByTime(5_000)
    release()
    vi.advanceTimersByTime(5_000)
    expect(pi.reports).toEqual(['active', undefined, 'active', undefined])
  })

  it('keeps a throwing provider active and ignores another session’s work', () => {
    const pi = piProcess()
    const bridge = pi.loadBridge()
    pi.registry().register({ name: 'other', sessionId: 'b', isActive: () => true })
    bridge.get('session_start')!({}, pi.ctx('a'))
    pi.registry().register({
      name: 'broken',
      sessionId: 'a',
      isActive: () => {
        throw new Error('provider failed')
      }
    })
    vi.advanceTimersByTime(5_000)
    expect(pi.reports).toEqual([undefined, 'active'])
  })

  it('hands the answer to a reloaded bridge, which reuses the registry its providers hold', () => {
    const pi = piProcess()
    const first = pi.loadBridge()
    pi.registry().register({ name: 'pi-subagents', sessionId: 'a', isActive: () => true })
    first.get('session_start')!({}, pi.ctx('a'))
    first.get('session_shutdown')!({}, pi.ctx('a'))
    const second = pi.loadBridge()
    second.get('session_start')!({}, pi.ctx('a'))
    vi.advanceTimersByTime(20_000)
    expect(pi.reports).toEqual(['active', undefined, 'active'])
  })
})
