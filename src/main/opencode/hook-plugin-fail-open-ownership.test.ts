/**
 * Executes the generated OpenCode plugin source because fail-open ownership
 * lives inside OpenCode's process, not in Orca's TypeScript runtime.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { getPathMock } = vi.hoisted(() => ({
  getPathMock: vi.fn<(name: string) => string>()
}))

vi.mock('electron', () => ({
  app: { getPath: getPathMock }
}))

import { _internals } from './hook-service'

type SessionFixture = { id: string; parentID?: string }
type PluginEvent = { type: string; properties?: Record<string, unknown> }
type PluginEventHandler = (input: { event: PluginEvent }) => Promise<void>
type PluginHooks = { event: PluginEventHandler; dispose?: () => Promise<void> }
type RecordedPost = {
  hook_event_name: string
  sessionID?: string
}

const ENV_KEYS = [
  'ORCA_PANE_KEY',
  'ORCA_AGENT_HOOK_PORT',
  'ORCA_AGENT_HOOK_TOKEN',
  'ORCA_AGENT_HOOK_ENDPOINT'
] as const

describe('OpenCode plugin fail-open ownership', () => {
  let tempDir: string
  let posts: RecordedPost[]
  let savedEnv: Record<string, string | undefined>
  let savedFetch: typeof globalThis.fetch

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'orca-opencode-fail-open-plugin-'))
    posts = []
    savedEnv = {}
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key]
    }
    process.env.ORCA_PANE_KEY = 'tab-1:leaf-1'
    process.env.ORCA_AGENT_HOOK_PORT = '45678'
    process.env.ORCA_AGENT_HOOK_TOKEN = 'test-token'
    delete process.env.ORCA_AGENT_HOOK_ENDPOINT
    savedFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      posts.push(readPayload(init))
      return new Response(null, { status: 204 })
    }) as typeof globalThis.fetch
  })

  afterEach(() => {
    vi.useRealTimers()
    globalThis.fetch = savedFetch
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = savedEnv[key]
      }
    }
    rmSync(tempDir, { recursive: true, force: true })
  })

  function readPayload(init?: RequestInit): RecordedPost {
    return JSON.parse(String(init?.body)).payload as RecordedPost
  }

  async function loadHooks(
    list: () => Promise<{ data: SessionFixture[] }> = async () => ({
      data: [{ id: 'root' }]
    })
  ): Promise<PluginHooks> {
    return loadHooksWithSession({ list })
  }

  async function loadHooksWithSession(session: object): Promise<PluginHooks> {
    return loadHooksWithContext({ client: { session } })
  }

  async function loadHooksWithContext(context: unknown): Promise<PluginHooks> {
    const pluginPath = join(tempDir, 'orca-opencode-status.mjs')
    writeFileSync(pluginPath, _internals.getOpenCodePluginSource())
    const module = (await import(pathToFileURL(pluginPath).href)) as {
      OrcaOpenCodeStatusPlugin: (ctx: unknown) => Promise<PluginHooks>
    }
    return module.OrcaOpenCodeStatusPlugin(context)
  }

  function status(type: 'busy' | 'idle' | 'retry', sessionID = 'root'): PluginEvent {
    return {
      type: 'session.status',
      properties: { sessionID, status: { type } }
    }
  }

  function names(): string[] {
    return posts.map((post) => post.hook_event_name)
  }

  function rejectWhenAborted(signal: AbortSignal | undefined): Promise<never> {
    if (!signal) {
      return Promise.reject(new Error('missing abort signal'))
    }
    return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    })
  }

  it('retires a provisional Busy when the factory has no SDK client', async () => {
    const hooks = await loadHooksWithContext(undefined)

    await hooks.event({ event: status('busy') })
    await hooks.event({ event: status('idle') })

    expect(names()).toEqual(['SessionBusy', 'SessionIdle'])
  })

  it('keeps concurrent provisional Busy owners active until each exact session retires', async () => {
    const first = await loadHooksWithContext(undefined)
    const second = await loadHooksWithContext(undefined)

    await first.event({ event: status('busy', 'unknown-a') })
    await second.event({ event: status('busy', 'unknown-b') })
    await first.event({ event: status('idle', 'unknown-a') })
    expect(names()).toEqual(['SessionBusy', 'SessionBusy'])

    await second.event({ event: status('idle', 'unknown-b') })
    expect(names()).toEqual(['SessionBusy', 'SessionBusy', 'SessionIdle'])
  })

  it('keeps same-session provisional Busy ownership separate across factories', async () => {
    const first = await loadHooksWithContext(undefined)
    const second = await loadHooksWithContext(undefined)

    await first.event({ event: status('busy', 'same-session') })
    await second.event({ event: status('busy', 'same-session') })
    await first.event({ event: status('idle', 'same-session') })
    expect(names()).toEqual(['SessionBusy'])

    await second.event({ event: status('idle', 'same-session') })
    expect(names()).toEqual(['SessionBusy', 'SessionIdle'])
  })

  it('does not evict an active provisional owner under high concurrency', async () => {
    const hooks = await loadHooksWithContext(undefined)

    for (let index = 0; index < 129; index += 1) {
      await hooks.event({ event: status('busy', `unknown-${index}`) })
    }
    for (let index = 1; index < 129; index += 1) {
      await hooks.event({ event: status('idle', `unknown-${index}`) })
    }
    expect(names().at(-1)).toBe('SessionBusy')
    expect(posts.at(-1)?.sessionID).toBe('unknown-0')

    await hooks.event({ event: status('idle', 'unknown-0') })
    expect(names().at(-1)).toBe('SessionIdle')
  })

  it('drains an older preview before unknown Idle retires its exact known root', async () => {
    const sessions = Array.from({ length: 129 }, (_, index) => ({ id: `root-${index}` }))
    let lookupFails = false
    const list = vi.fn(async () => {
      if (lookupFails) {
        throw new Error('lookup unavailable')
      }
      return { data: sessions }
    })
    let releasePart: (() => void) | undefined
    const delayedPart = new Promise<void>((resolve) => {
      releasePart = resolve
    })
    let notifyPartStarted: (() => void) | undefined
    const partStarted = new Promise<void>((resolve) => {
      notifyPartStarted = resolve
    })
    globalThis.fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const payload = readPayload(init)
      if (payload.hook_event_name === 'MessagePart') {
        notifyPartStarted?.()
        await delayedPart
      }
      posts.push(payload)
      return new Response(null, { status: 204 })
    }) as typeof globalThis.fetch
    const hooks = await loadHooks(list)

    await hooks.event({ event: status('busy', 'root-0') })
    await hooks.event({
      event: {
        type: 'message.updated',
        properties: {
          sessionID: 'root-0',
          info: { id: 'assistant-message', role: 'assistant' }
        }
      }
    })
    const preview = hooks.event({
      event: {
        type: 'message.part.updated',
        properties: {
          sessionID: 'root-0',
          part: {
            type: 'text',
            text: 'older preview',
            messageID: 'assistant-message'
          }
        }
      }
    })
    await partStarted

    // Why: evict only root-0's ancestry cache entry while its preview is in flight.
    for (let index = 1; index < sessions.length; index += 1) {
      await hooks.event({
        event: {
          type: 'message.updated',
          properties: {
            sessionID: `root-${index}`,
            info: { id: `message-${index}`, role: 'assistant' }
          }
        }
      })
    }
    lookupFails = true
    const callsBeforeIdle = list.mock.calls.length
    const idle = hooks.event({ event: status('idle', 'root-0') })
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(callsBeforeIdle + 1))
    await new Promise<void>((resolve) => {
      setImmediate(resolve)
    })
    const namesBeforeRelease = names()

    releasePart?.()
    await Promise.all([preview, idle])

    expect(namesBeforeRelease).toEqual(['SessionBusy'])
    expect(names()).toEqual(['SessionBusy', 'MessagePart', 'SessionIdle'])
  })

  it('drops a delayed text handler after its Waiting blocker resolves to Idle', async () => {
    let lookupBlocks = false
    let releaseLookup: (() => void) | undefined
    const delayedLookup = new Promise<void>((resolve) => {
      releaseLookup = resolve
    })
    let notifyLookupStarted: (() => void) | undefined
    const lookupStarted = new Promise<void>((resolve) => {
      notifyLookupStarted = resolve
    })
    const list = vi.fn(async () => {
      if (!lookupBlocks) {
        throw new Error('lookup unavailable')
      }
      notifyLookupStarted?.()
      await delayedLookup
      return { data: [{ id: 'root' }] }
    })
    const hooks = await loadHooks(list)
    await hooks.event({
      event: {
        type: 'message.updated',
        properties: {
          sessionID: 'root',
          info: { id: 'assistant-message', role: 'assistant' }
        }
      }
    })
    await hooks.event({
      event: {
        type: 'question.asked',
        properties: { id: 'question-root', sessionID: 'root' }
      }
    })
    lookupBlocks = true
    const preview = hooks.event({
      event: {
        type: 'message.part.updated',
        properties: {
          sessionID: 'root',
          part: {
            type: 'text',
            text: 'stale preview',
            messageID: 'assistant-message'
          }
        }
      }
    })
    await lookupStarted

    await hooks.event({
      event: {
        type: 'question.replied',
        properties: { requestID: 'question-root', sessionID: 'root' }
      }
    })
    expect(names()).toEqual(['AskUserQuestion', 'SessionIdle'])

    releaseLookup?.()
    await preview

    expect(names()).toEqual(['AskUserQuestion', 'SessionIdle'])
  })

  it('disposes only its provisional Busy owner and reasserts the survivor', async () => {
    const first = await loadHooksWithContext(undefined)
    const second = await loadHooksWithContext(undefined)

    await first.event({ event: status('busy', 'unknown-a') })
    await second.event({ event: status('busy', 'unknown-b') })
    await second.dispose?.()
    expect(names()).toEqual(['SessionBusy', 'SessionBusy', 'SessionBusy'])
    expect(posts.at(-1)?.sessionID).toBe('unknown-a')

    await first.dispose?.()
    expect(names()).toEqual(['SessionBusy', 'SessionBusy', 'SessionBusy', 'SessionIdle'])
  })

  it('lets exact unknown-session Idle clear a blocker without SDK lookup', async () => {
    const hooks = await loadHooksWithContext(undefined)

    await hooks.event({
      event: {
        type: 'question.asked',
        properties: { id: 'question-unknown', sessionID: 'unknown' }
      }
    })
    await hooks.event({ event: status('idle', 'unknown') })

    expect(names()).toEqual(['AskUserQuestion', 'SessionIdle'])
  })

  it('does not let another unknown session Busy overwrite an active blocker', async () => {
    const hooks = await loadHooksWithContext(undefined)

    await hooks.event({
      event: {
        type: 'permission.asked',
        properties: { id: 'permission-root', sessionID: 'root' }
      }
    })
    await hooks.event({ event: status('busy', 'other-session') })

    expect(names()).toEqual(['PermissionRequest'])
  })

  it('ignores malformed attention that has no required sessionID', async () => {
    const hooks = await loadHooksWithContext(undefined)

    await hooks.event({
      event: {
        type: 'question.asked',
        properties: { id: 'question-without-session' }
      }
    })
    await hooks.event({
      event: {
        type: 'permission.asked',
        properties: { id: 'permission-without-session' }
      }
    })

    expect(names()).toEqual([])
  })

  it('retires provisional Busy after both ancestry lookups time out', async () => {
    vi.useFakeTimers()
    const list = vi.fn((options?: { signal?: AbortSignal }) => rejectWhenAborted(options?.signal))
    const hooks = await loadHooksWithSession({ list })

    const busy = hooks.event({ event: status('busy') })
    await vi.advanceTimersByTimeAsync(2_000)
    await busy
    expect(names()).toEqual(['SessionBusy'])

    const idle = hooks.event({ event: status('idle') })
    await vi.advanceTimersByTimeAsync(2_000)
    await idle
    expect(names()).toEqual(['SessionBusy', 'SessionIdle'])
  })

  it('promotes provisional Busy when later lookup confirms the root', async () => {
    let lookupFails = true
    const list = vi.fn(async () => {
      if (lookupFails) {
        throw new Error('lookup unavailable')
      }
      return { data: [{ id: 'root' }] }
    })
    const hooks = await loadHooksWithSession({ list })

    await hooks.event({ event: status('busy') })
    lookupFails = false
    await hooks.event({
      event: {
        type: 'question.asked',
        properties: { id: 'question-root', sessionID: 'root' }
      }
    })
    await hooks.event({
      event: {
        type: 'question.replied',
        properties: { requestID: 'question-root', sessionID: 'root' }
      }
    })
    await hooks.event({ event: status('idle') })

    expect(names()).toEqual(['SessionBusy', 'AskUserQuestion', 'SessionBusy', 'SessionIdle'])
  })

  it('keeps a confirmed child provisionally Busy until its matching Idle', async () => {
    let lookupFails = true
    const list = vi.fn(async () => {
      if (lookupFails) {
        throw new Error('lookup unavailable')
      }
      return { data: [{ id: 'root' }, { id: 'child', parentID: 'root' }] }
    })
    const hooks = await loadHooksWithSession({ list })

    await hooks.event({ event: status('busy', 'child') })
    lookupFails = false
    await hooks.event({ event: status('busy', 'child') })
    expect(names()).toEqual(['SessionBusy'])

    await hooks.event({ event: status('idle', 'child') })
    expect(names()).toEqual(['SessionBusy', 'SessionIdle'])
  })
})
