import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const { getPathMock } = vi.hoisted(() => ({
  getPathMock: vi.fn<(name: string) => string>()
}))

vi.mock('electron', () => ({
  app: {
    getPath: getPathMock
  }
}))

import { _internals } from './hook-service'

describe('OpenCode status plugin module contract', () => {
  type PluginHooks = {
    event: (input: { event: unknown }) => Promise<void>
    dispose?: () => Promise<void>
  }
  type PluginModule = {
    default?: {
      id?: unknown
      server?: (ctx: unknown) => Promise<PluginHooks>
      setup?: (ctx: unknown) => Promise<() => Promise<void>>
    }
    OrcaOpenCodeStatusPlugin?: (ctx: unknown) => Promise<PluginHooks>
  }

  // Isolate endpoint-file and environment inputs so tests cannot post to a live Orca session.
  const ENV_KEYS = [
    'ORCA_OPENCODE_PLUGIN_API',
    'ORCA_PANE_KEY',
    'ORCA_AGENT_HOOK_ENDPOINT',
    'ORCA_AGENT_HOOK_PORT',
    'ORCA_AGENT_HOOK_TOKEN'
  ] as const

  let tempDir: string
  let savedFetch: typeof globalThis.fetch
  let savedEnv: Record<string, string | undefined>

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'orca-opencode-plugin-contract-'))
    savedFetch = globalThis.fetch
    savedEnv = {}
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key]
    }
    // An inherited major selector can disable the generated plugin.
    delete process.env.ORCA_OPENCODE_PLUGIN_API
    delete process.env.ORCA_OPENCODE_AGENT
    delete process.env.ORCA_AGENT_HOOK_ENDPOINT
    process.env.ORCA_AGENT_HOOK_PORT = '59999'
    process.env.ORCA_AGENT_HOOK_TOKEN = 'test-token'
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

  type HookPost = { url: string; body: Record<string, unknown> }

  function captureHookPosts(): HookPost[] {
    const posts: HookPost[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      posts.push({ url: String(input), body: JSON.parse(String(init?.body ?? '{}')) })
      return new Response(null)
    })
    return posts
  }

  function hookEventName(payload: unknown): unknown {
    return typeof payload === 'object' && payload !== null && 'hook_event_name' in payload
      ? payload.hook_event_name
      : undefined
  }

  async function loadPluginModule(
    source = _internals.getOpenCodePluginSource()
  ): Promise<PluginModule> {
    // Bypass ESM caching between cases.
    const pluginPath = join(
      tempDir,
      `orca-opencode-status-${Math.random().toString(36).slice(2)}.mjs`
    )
    writeFileSync(pluginPath, source)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Runtime validation or the local test fixture establishes the asserted shape.
    return (await import(pathToFileURL(pluginPath).href)) as PluginModule
  }

  it('selects the same factory for a v1 execution host', async () => {
    process.env.ORCA_OPENCODE_PLUGIN_API = 'v1'
    const module = await loadPluginModule()
    expect(module.default).toBeTypeOf('function')
    expect(module.default).toBe(module.OrcaOpenCodeStatusPlugin)
  })

  it('reports a session lifecycle event through the hook endpoint when driven via the default export', async () => {
    process.env.ORCA_PANE_KEY = 'tab-1:leaf-1'
    const posts = captureHookPosts()

    const module = await loadPluginModule()
    const hooks = await module.default?.server?.({
      client: {
        session: {
          get: async () => ({ data: { id: 'ses_root', parentID: undefined } })
        }
      }
    })

    await hooks?.event({
      event: {
        type: 'session.status',
        properties: { sessionID: 'ses_root', status: { type: 'busy' } }
      }
    })
    // Let queued lifecycle delivery drain before asserting.
    await new Promise((resolve) => setTimeout(resolve, 50))

    const hookPosts = posts.filter((post) => post.url.includes('/hook/opencode'))
    expect(hookPosts.length).toBeGreaterThan(0)
    expect(hookPosts[0]?.body).toMatchObject({
      paneKey: 'tab-1:leaf-1',
      payload: { hook_event_name: 'SessionBusy' }
    })
  })

  it('keeps OpenCode 2 busy across steps until the session becomes idle', async () => {
    process.env.ORCA_PANE_KEY = 'tab-1:leaf-1'
    const posts = captureHookPosts()

    const module = await loadPluginModule(_internals.getOpenCode2PluginSource())
    const hooks = await module.default?.server?.({
      client: { session: { get: async () => ({ data: { id: 'ses_root' } }) } }
    })
    await hooks?.event({
      event: {
        type: 'session.next.step.started',
        properties: { sessionID: 'ses_root', assistantMessageID: 'msg-1' }
      }
    })
    await hooks?.event({
      event: {
        type: 'session.next.step.ended',
        properties: { sessionID: 'ses_root', assistantMessageID: 'msg-1' }
      }
    })
    expect(posts).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          payload: expect.objectContaining({ hook_event_name: 'SessionIdle' })
        })
      ])
    )
    await hooks?.event({ event: { type: 'session.idle', properties: { sessionID: 'ses_root' } } })
    await new Promise((resolve) => setTimeout(resolve, 50))
    const hookEvents = posts.map((post) => hookEventName(post.body.payload))
    expect(hookEvents).toContain('SessionBusy')
    expect(hookEvents).toContain('SessionIdle')
  })

  it('maps OpenCode 2 permission.v2 events to the existing permission card contract', async () => {
    process.env.ORCA_PANE_KEY = 'tab-1:leaf-1'
    const posts = captureHookPosts()

    const module = await loadPluginModule(_internals.getOpenCode2PluginSource())
    const hooks = await module.default?.server?.({
      client: { session: { get: async () => ({ data: { id: 'ses_root' } }) } }
    })
    await hooks?.event({
      event: {
        type: 'permission.v2.asked',
        properties: {
          id: 'perm-1',
          sessionID: 'ses_root',
          action: 'bash',
          resources: ['git status']
        }
      }
    })
    await new Promise((resolve) => setTimeout(resolve, 50))

    const hookEvents = posts.map((post) => hookEventName(post.body.payload))
    expect(hookEvents).toContain('PermissionRequest')
    expect(
      posts.find((post) => hookEventName(post.body.payload) === 'PermissionRequest')?.body
    ).toMatchObject({
      payload: {
        permission: 'bash',
        patterns: ['git status']
      }
    })
  })

  it('forwards admitted prompts and completed streamed text once', async () => {
    process.env.ORCA_PANE_KEY = 'tab-1:leaf-1'
    const posts = captureHookPosts()

    const module = await loadPluginModule(_internals.getOpenCode2PluginSource())
    const hooks = await module.default?.server?.({
      client: { session: { get: async () => ({ data: { id: 'ses_root' } }) } }
    })
    await hooks?.event({
      event: {
        type: 'session.next.prompt.admitted',
        properties: {
          sessionID: 'ses_root',
          messageID: 'msg-user',
          prompt: { text: 'Inspect the repository' }
        }
      }
    })
    await hooks?.event({
      event: {
        type: 'session.next.text.ended',
        properties: {
          sessionID: 'ses_root',
          assistantMessageID: 'msg-assistant',
          textID: 'text-1',
          text: 'The repository is ready.'
        }
      }
    })
    await new Promise((resolve) => setTimeout(resolve, 80))

    const messageBodies = posts
      .map((post) => post.body.payload)
      .filter(
        (payload): payload is Record<string, unknown> =>
          typeof payload === 'object' && payload !== null && 'role' in payload
      )
    expect(messageBodies).toEqual([
      expect.objectContaining({ role: 'user', text: 'Inspect the repository' }),
      expect.objectContaining({ role: 'assistant', text: 'The repository is ready.' })
    ])
  })

  it('maps question.v2 blockers and replies through the waiting lifecycle', async () => {
    process.env.ORCA_PANE_KEY = 'tab-1:leaf-1'
    const posts = captureHookPosts()

    const module = await loadPluginModule(_internals.getOpenCode2PluginSource())
    const hooks = await module.default?.server?.({
      client: { session: { get: async () => ({ data: { id: 'ses_root' } }) } }
    })
    await hooks?.event({
      event: {
        type: 'question.v2.asked',
        properties: {
          id: 'que-1',
          sessionID: 'ses_root',
          questions: [{ question: 'Which branch?', header: 'Branch', options: [] }]
        }
      }
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(posts.map((post) => post.body.payload)).toContainEqual(
      expect.objectContaining({ hook_event_name: 'AskUserQuestion' })
    )

    await hooks?.event({
      event: {
        type: 'question.v2.rejected',
        properties: { requestID: 'que-1', sessionID: 'ses_root' }
      }
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    const lastPayload = posts.at(-1)?.body.payload
    expect(lastPayload).toEqual(expect.objectContaining({ hook_event_name: 'SessionIdle' }))
  })
})
