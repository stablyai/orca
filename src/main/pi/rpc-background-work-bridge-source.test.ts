import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createContext, runInContext } from 'node:vm'
// TypeScript 7 is a native CLI; transpile tests still need the legacy JavaScript API.
import ts from 'typescript-api'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  PI_BACKGROUND_WORK_DIR_ENV,
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

const folders: string[] = []
afterEach(() => {
  folders.splice(0).forEach((folder) => rmSync(folder, { recursive: true, force: true }))
})

/** One Pi process: a realm whose globalThis outlives extension reloads, as Pi's does. */
function piProcess() {
  const directory = mkdtempSync(join(tmpdir(), 'orca-pi-probe-'))
  folders.push(directory)
  const output = ts.transpileModule(getPiBackgroundWorkBridgeSource(), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
  }).outputText
  const exports: { default?: unknown } = {}
  const realm = createContext({
    exports,
    require: createRequire(import.meta.url),
    process: { env: { [PI_BACKGROUND_WORK_DIR_ENV]: directory } }
  })
  const reports: string[] = []
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
        if (key === PI_BACKGROUND_WORK_STATUS_KEY && text) {
          reports.push(text)
        }
      }
    }
  })
  const ready = () => reports.findLast((report) => report.startsWith('ready:'))?.slice(6) ?? ''
  /** Drop a request the way Orca does and wait for the matching answer. */
  const probe = async (instance: string, nonce: string) => {
    writeFileSync(join(directory, `${instance}.${nonce}.probe`), '')
    const answer = (): string | undefined =>
      reports.find((report) => report.startsWith(`answer:${instance}:${nonce}:`))
    await vi.waitFor(() => expect(answer()).toBeDefined())
    return answer()
  }
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
  return { directory, loadBridge, ctx, reports, ready, probe, registry }
}

describe('the Pi background-work bridge', () => {
  it('answers each request from providers that registered after it loaded', async () => {
    const pi = piProcess()
    const bridge = pi.loadBridge()
    let running = true
    const release = pi.registry().register({
      name: 'pi-subagents',
      sessionId: 'a',
      isActive: () => running
    })
    pi.registry().register({ name: 'other session', sessionId: 'b', isActive: () => true })
    expect(() => pi.registry().register({ sessionId: 'a', isActive: () => true })).toThrow()
    bridge.get('session_start')!({}, pi.ctx('a'))
    const instance = pi.ready()

    expect(await pi.probe(instance, 'n1')).toBe(`answer:${instance}:n1:active`)
    running = false
    expect(await pi.probe(instance, 'n2')).toBe(`answer:${instance}:n2:idle`)
    running = true
    release()
    expect(await pi.probe(instance, 'n3')).toBe(`answer:${instance}:n3:idle`)
    bridge.get('session_shutdown')!({}, pi.ctx('a'))
  })

  it('leaves a reloaded predecessor’s requests unanswered and hands the registry on', async () => {
    const pi = piProcess()
    const first = pi.loadBridge()
    pi.registry().register({
      name: 'broken',
      sessionId: 'a',
      isActive: () => {
        throw new Error('provider failed')
      }
    })
    first.get('session_start')!({}, pi.ctx('a'))
    const old = pi.ready()
    first.get('session_shutdown')!({}, pi.ctx('a'))
    expect(pi.reports.at(-1)).toBe('gone')

    const second = pi.loadBridge()
    second.get('session_start')!({}, pi.ctx('a'))
    const current = pi.ready()
    expect(current).not.toBe(old)
    writeFileSync(join(pi.directory, `${old}.stale.probe`), '')
    expect(await pi.probe(current, 'n1')).toBe(`answer:${current}:n1:active`)
    expect(pi.reports.some((report) => report.includes(':stale:'))).toBe(false)
    expect(existsSync(join(pi.directory, `${old}.stale.probe`))).toBe(true)
    second.get('session_shutdown')!({}, pi.ctx('a'))
  })
})
