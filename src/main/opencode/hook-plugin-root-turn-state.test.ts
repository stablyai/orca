/**
 * Executes the generated OpenCode plugin source to verify that every post
 * carries the root session's own state, and the error name that ended it.
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

type PluginEvent = { type: string; properties?: Record<string, unknown> }
type PluginHooks = {
  event: (input: { event: PluginEvent }) => Promise<void>
  dispose?: () => Promise<void>
}
type RecordedPost = {
  hook_event_name: string
  sessionID?: string
  role?: string
  root_state?: string
  root_turn_error_name?: string
}

const ENV_KEYS = [
  'ORCA_PANE_KEY',
  'ORCA_AGENT_HOOK_PORT',
  'ORCA_AGENT_HOOK_TOKEN',
  'ORCA_AGENT_HOOK_ENDPOINT'
] as const

describe('OpenCode plugin root turn state', () => {
  let tempDir: string
  let posts: RecordedPost[]
  let savedEnv: Record<string, string | undefined>
  let savedFetch: typeof globalThis.fetch

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'orca-opencode-root-turn-'))
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
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the plugin only awaits the response status, which this stub supplies.
    globalThis.fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the plugin always posts a JSON body carrying `payload`.
      posts.push((JSON.parse(String(init?.body)) as { payload: RecordedPost }).payload)
      return new Response(null, { status: 204 })
    }) as typeof globalThis.fetch
  })

  afterEach(() => {
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

  async function loadHooks(): Promise<PluginHooks> {
    const pluginPath = join(tempDir, 'orca-opencode-status.mjs')
    writeFileSync(pluginPath, _internals.getOpenCodePluginSource())
    const module = (await import(pathToFileURL(pluginPath).href)) as {
      OrcaOpenCodeStatusPlugin: (ctx: unknown) => Promise<PluginHooks>
    }
    const list = async (): Promise<{ data: { id: string }[] }> => ({ data: [{ id: 'root' }] })
    return module.OrcaOpenCodeStatusPlugin({ client: { session: { list } } })
  }

  function status(type: 'busy' | 'idle'): PluginEvent {
    return { type: 'session.status', properties: { sessionID: 'root', status: { type } } }
  }

  function sessionError(error: unknown): PluginEvent {
    return { type: 'session.error', properties: { sessionID: 'root', error } }
  }

  function textPart(role: 'user' | 'assistant', text: string): PluginEvent[] {
    const messageID = `${role}-message`
    return [
      { type: 'message.updated', properties: { info: { id: messageID, role } } },
      {
        type: 'message.part.updated',
        properties: { sessionID: 'root', part: { type: 'text', text, messageID } }
      }
    ]
  }

  async function send(hooks: PluginHooks, ...events: PluginEvent[]): Promise<void> {
    for (const event of events) {
      await hooks.event({ event })
    }
  }

  it('names the error that ended the root turn on its one Idle', async () => {
    const hooks = await loadHooks()

    await send(hooks, status('busy'), sessionError({ name: 'ProviderAuthError', data: {} }))
    await send(hooks, status('idle'), { type: 'session.idle', properties: { sessionID: 'root' } })

    expect(posts).toEqual([
      { hook_event_name: 'SessionBusy', sessionID: 'root', root_state: 'working' },
      {
        hook_event_name: 'SessionIdle',
        sessionID: 'root',
        root_state: 'done',
        root_turn_error_name: 'ProviderAuthError'
      }
    ])
  })

  it('bounds the error name and drops one that is empty', async () => {
    const hooks = await loadHooks()

    await send(hooks, status('busy'), sessionError({ name: 'E'.repeat(100) }), status('idle'))
    expect(posts.at(-1)?.root_turn_error_name).toBe('E'.repeat(64))

    await send(hooks, status('busy'), sessionError({ data: {} }), status('idle'))
    expect(posts.at(-1)).toEqual({
      hook_event_name: 'SessionIdle',
      sessionID: 'root',
      root_state: 'done'
    })
  })

  it('never names a recoverable overflow once compaction continues the turn', async () => {
    const hooks = await loadHooks()

    await send(hooks, status('busy'), sessionError({ name: 'ContextOverflowError' }))
    await send(hooks, status('busy'), status('idle'))

    expect(posts.some((post) => post.root_turn_error_name !== undefined)).toBe(false)
    expect(posts.at(-1)).toEqual({
      hook_event_name: 'SessionIdle',
      sessionID: 'root',
      root_state: 'done'
    })
  })

  it('names a compaction that failed after the overflow', async () => {
    const hooks = await loadHooks()

    await send(hooks, status('busy'), sessionError({ name: 'ContextOverflowError' }))
    await send(hooks, status('busy'), sessionError({ name: 'ContextOverflowError' }))
    await send(hooks, status('idle'))

    expect(posts.at(-1)).toMatchObject({
      hook_event_name: 'SessionIdle',
      root_state: 'done',
      root_turn_error_name: 'ContextOverflowError'
    })
  })

  it('reports root attention as waiting and retires the earlier error', async () => {
    const hooks = await loadHooks()

    await send(hooks, status('busy'), sessionError({ name: 'APIError' }), status('idle'))
    await send(hooks, {
      type: 'permission.asked',
      properties: { id: 'perm-1', sessionID: 'root', permission: 'bash' }
    })
    expect(posts.at(-1)).toMatchObject({
      hook_event_name: 'PermissionRequest',
      root_state: 'waiting'
    })
    expect(posts.at(-1)).not.toHaveProperty('root_turn_error_name')

    await send(hooks, {
      type: 'permission.replied',
      properties: { sessionID: 'root', requestID: 'perm-1', response: 'once' }
    })
    expect(posts.at(-1)).toEqual({
      hook_event_name: 'SessionIdle',
      sessionID: 'root',
      root_state: 'done'
    })
  })

  it('carries the root state on MessagePart posts, and a new prompt retires the error', async () => {
    const hooks = await loadHooks()

    await send(hooks, status('busy'), ...textPart('assistant', 'working on it'))
    await vi.waitFor(() =>
      expect(posts.at(-1)).toMatchObject({ hook_event_name: 'MessagePart', root_state: 'working' })
    )

    await send(hooks, sessionError({ name: 'APIError' }), status('idle'))
    expect(posts.at(-1)?.root_turn_error_name).toBe('APIError')

    // OpenCode records the next prompt before its Busy.
    await send(hooks, ...textPart('user', 'try again'))
    expect(posts.at(-1)).toEqual(
      expect.objectContaining({ hook_event_name: 'MessagePart', role: 'user', root_state: 'done' })
    )
    expect(posts.at(-1)).not.toHaveProperty('root_turn_error_name')
  })
})
