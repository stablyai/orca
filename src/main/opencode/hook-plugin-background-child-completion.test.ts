/**
 * Executes the generated OpenCode plugin artifact to verify that a running
 * background child session keeps the pane working, so a root turn that ends
 * first cannot publish a false completion for the whole task tree.
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
type PluginFactory = (ctx: unknown) => Promise<PluginHooks>
type SessionList = (
  parameters?: { signal?: AbortSignal },
  options?: { signal?: AbortSignal }
) => Promise<{ data: SessionFixture[] }>
type RecordedPost = {
  hook_event_name: string
  sessionID?: string
  role?: string
  text?: string
}

const ENV_KEYS = [
  'ORCA_PANE_KEY',
  'ORCA_AGENT_HOOK_PORT',
  'ORCA_AGENT_HOOK_TOKEN',
  'ORCA_AGENT_HOOK_ENDPOINT'
] as const

describe('OpenCode plugin background child completion', () => {
  let tempDir: string
  let posts: RecordedPost[]
  let savedEnv: Record<string, string | undefined>
  let savedFetch: typeof globalThis.fetch
  let pluginFactory: PluginFactory | undefined

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'orca-opencode-background-child-'))
    posts = []
    savedEnv = {}
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key]
    }
    process.env.ORCA_PANE_KEY = 'tab-1:leaf-1'
    process.env.ORCA_AGENT_HOOK_PORT = '45678'
    process.env.ORCA_AGENT_HOOK_TOKEN = 'test-token'
    delete process.env.ORCA_AGENT_HOOK_ENDPOINT
    pluginFactory = undefined
    savedFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { payload: RecordedPost }
      posts.push(body.payload)
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

  async function createHooks(
    sessions: SessionFixture[],
    list: SessionList = async () => ({ data: sessions })
  ): Promise<PluginHooks> {
    if (!pluginFactory) {
      const pluginPath = join(tempDir, 'orca-opencode-status.mjs')
      writeFileSync(pluginPath, _internals.getOpenCodePluginSource())
      const module = (await import(pathToFileURL(pluginPath).href)) as {
        OrcaOpenCodeStatusPlugin: PluginFactory
      }
      pluginFactory = module.OrcaOpenCodeStatusPlugin
    }
    return pluginFactory({ client: { session: { list } } })
  }

  function status(type: 'busy' | 'idle', sessionID: string): PluginEvent {
    return { type: 'session.status', properties: { sessionID, status: { type } } }
  }

  function names(): string[] {
    return posts.map((post) => post.hook_event_name)
  }

  const TASK_TREE = [{ id: 'root' }, { id: 'child', parentID: 'root' }]

  it('keeps the pane working when the root turn ends while a background child runs', async () => {
    const hooks = await createHooks(TASK_TREE)

    await hooks.event({ event: status('busy', 'root') })
    await hooks.event({ event: status('busy', 'child') })
    await hooks.event({ event: status('idle', 'root') })

    expect(names()).not.toContain('SessionIdle')

    await hooks.event({ event: status('idle', 'child') })

    expect(names()).toEqual(['SessionBusy', 'SessionIdle'])
    expect(posts.at(-1)?.sessionID).toBe('root')
  })

  it('does not publish a completion when only a background child finishes', async () => {
    const hooks = await createHooks(TASK_TREE)

    await hooks.event({ event: status('busy', 'root') })
    await hooks.event({ event: status('busy', 'child') })
    await hooks.event({ event: status('idle', 'child') })

    expect(names()).toEqual(['SessionBusy'])
    expect(posts.at(-1)?.sessionID).toBe('root')
  })

  it('rolls a background child up to the root pane after the root turn already ended', async () => {
    const hooks = await createHooks(TASK_TREE)

    await hooks.event({ event: status('busy', 'root') })
    await hooks.event({ event: status('idle', 'root') })
    expect(names()).toEqual(['SessionBusy', 'SessionIdle'])

    await hooks.event({ event: status('busy', 'child') })
    expect(names().at(-1)).toBe('SessionBusy')
    expect(posts.at(-1)?.sessionID).toBe('root')

    await hooks.event({ event: status('idle', 'child') })
    expect(names()).toEqual(['SessionBusy', 'SessionIdle', 'SessionBusy', 'SessionIdle'])
  })

  it('publishes one completion for repeated root and child idle events', async () => {
    const hooks = await createHooks(TASK_TREE)

    await hooks.event({ event: status('busy', 'root') })
    await hooks.event({ event: status('busy', 'child') })
    await hooks.event({ event: status('idle', 'child') })
    await hooks.event({ event: status('idle', 'root') })
    await hooks.event({ event: status('idle', 'root') })
    await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'root' } } })
    await hooks.event({ event: status('idle', 'child') })

    expect(names().filter((name) => name === 'SessionIdle')).toHaveLength(1)
    expect(names().at(-1)).toBe('SessionIdle')
  })

  it('keeps every concurrent background child accounted for', async () => {
    const hooks = await createHooks([
      { id: 'root' },
      { id: 'child-a', parentID: 'root' },
      { id: 'child-b', parentID: 'child-a' }
    ])

    await hooks.event({ event: status('busy', 'root') })
    await hooks.event({ event: status('busy', 'child-a') })
    await hooks.event({ event: status('busy', 'child-b') })
    await hooks.event({ event: status('idle', 'root') })
    await hooks.event({ event: status('idle', 'child-a') })
    expect(names()).not.toContain('SessionIdle')

    await hooks.event({ event: status('idle', 'child-b') })
    expect(names()).toEqual(['SessionBusy', 'SessionIdle'])
    expect(posts.at(-1)?.sessionID).toBe('root')
  })

  it('retires a background child through an Idle whose ancestry cannot be resolved', async () => {
    let resolvable = true
    const hooks = await createHooks([], async () =>
      resolvable ? { data: TASK_TREE } : Promise.reject(new Error('sdk outage'))
    )

    await hooks.event({ event: status('busy', 'root') })
    await hooks.event({ event: status('busy', 'child') })
    await hooks.event({ event: status('idle', 'root') })
    expect(names()).not.toContain('SessionIdle')

    resolvable = false
    await hooks.event({ event: status('idle', 'child') })

    expect(names()).toEqual(['SessionBusy', 'SessionIdle'])
  })

  it('drops a disposed factory background child instead of pinning the pane', async () => {
    const first = await createHooks(TASK_TREE)
    const second = await createHooks(TASK_TREE)

    await first.event({ event: status('busy', 'root') })
    await first.event({ event: status('busy', 'child') })
    await first.event({ event: status('idle', 'root') })
    expect(names()).not.toContain('SessionIdle')

    await first.dispose?.()

    expect(names().at(-1)).toBe('SessionIdle')
    await second.dispose?.()
  })

  it('ignores OpenCode synthetic task-result parts injected into the parent turn', async () => {
    const hooks = await createHooks(TASK_TREE)

    await hooks.event({
      event: {
        type: 'message.updated',
        properties: { info: { id: 'message-1', role: 'user' } }
      }
    })
    await hooks.event({
      event: {
        type: 'message.part.updated',
        properties: {
          sessionID: 'root',
          part: {
            type: 'text',
            text: 'ship the refactor',
            messageID: 'message-1'
          }
        }
      }
    })
    expect(posts.at(-1)).toMatchObject({
      hook_event_name: 'MessagePart',
      text: 'ship the refactor'
    })

    await hooks.event({
      event: {
        type: 'message.part.updated',
        properties: {
          sessionID: 'root',
          part: {
            type: 'text',
            text: '<task id="ses_child" state="completed">done</task>',
            messageID: 'message-1',
            synthetic: true
          }
        }
      }
    })

    expect(posts.filter((post) => post.hook_event_name === 'MessagePart')).toHaveLength(1)
    expect(posts.at(-1)?.text).toBe('ship the refactor')
  })
})
