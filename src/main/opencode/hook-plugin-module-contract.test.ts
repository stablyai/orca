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

// Execute the generated module against legacy and current plugin contracts.
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

  // Why: the plugin resolves hook coords from the endpoint file first and only then from
  // env. Pin every input here so the run does not depend on the developer's Orca session
  // (an inherited ORCA_AGENT_HOOK_ENDPOINT would otherwise redirect the post to a live app).
  const ENV_KEYS = [
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

  async function loadPluginModule(
    source = _internals.getOpenCodePluginSource()
  ): Promise<PluginModule> {
    // Why: a unique basename per load defeats the ESM module cache between cases.
    const pluginPath = join(
      tempDir,
      `orca-opencode-status-${Math.random().toString(36).slice(2)}.mjs`
    )
    writeFileSync(pluginPath, source)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Runtime validation or the local test fixture establishes the asserted shape.
    return (await import(pathToFileURL(pluginPath).href)) as PluginModule
  }

  it('exposes a default export carrying a string id and a callable server()', async () => {
    const module = await loadPluginModule()

    expect(module.default).toBeTypeOf('object')
    expect(typeof module.default?.id).toBe('string')
    expect(module.default?.id).toBe('orca-opencode-status')
    expect(module.default?.server).toBeTypeOf('function')
  })

  it('rejects the shape OpenCode refuses: a default export without server()', async () => {
    const module = await loadPluginModule()

    // Why: pins the specific reason the loader fails a module — `setup` alone is not
    // accepted, so a default export must never regress to it.
    expect(module.default).not.toBeUndefined()
    expect(Object.hasOwn(module.default ?? {}, 'server')).toBe(true)
  })

  it('keeps the named factory export so the factory-based loader still resolves', async () => {
    const module = await loadPluginModule()

    expect(module.OrcaOpenCodeStatusPlugin).toBeTypeOf('function')
  })

  it('returns an event handler from the default export server(), like the named factory', async () => {
    const module = await loadPluginModule()

    const fromDefault = await module.default?.server?.({})
    const fromNamed = await module.OrcaOpenCodeStatusPlugin?.({})

    expect(fromDefault?.event).toBeTypeOf('function')
    expect(fromNamed?.event).toBeTypeOf('function')
  })

  it('reports a session lifecycle event through the hook endpoint when driven via the default export', async () => {
    process.env.ORCA_PANE_KEY = 'tab-1:leaf-1'
    const posts: { url: string; body: unknown }[] = []
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The mocked fetch is assigned to the standard Fetch API shape.
    globalThis.fetch = vi.fn(async (input: unknown, init?: { body?: unknown }) => {
      posts.push({ url: String(input), body: JSON.parse(String(init?.body ?? '{}')) })
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Runtime validation or the local test fixture establishes the asserted shape.
      return { ok: true } as Response
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Runtime validation or the local test fixture establishes the asserted shape.
    }) as unknown as typeof globalThis.fetch

    const module = await loadPluginModule()
    const hooks = await module.default?.server?.({
      client: {
        session: {
          // Why: a root session (no parentID) must pass the child-session filter,
          // otherwise every event is dropped before it can post.
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
    // Why: lifecycle delivery is queued; let the plugin's FIFO drain before asserting.
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
    const posts: { body: Record<string, unknown> }[] = []
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The mocked fetch is assigned to the standard Fetch API shape.
    globalThis.fetch = vi.fn(async (_input: unknown, init?: { body?: unknown }) => {
      posts.push({ body: JSON.parse(String(init?.body ?? '{}')) })
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The mocked fetch returns the Response shape the plugin checks.
      return { ok: true } as Response
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The mocked fetch is assigned to the standard Fetch API shape.
    }) as unknown as typeof globalThis.fetch

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
    const hookEvents = posts.map((post) => {
      const payload = post.body.payload
      return typeof payload === 'object' && payload !== null
        ? // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The generated plugin payload is an object with a hook_event_name field.
          (payload as { hook_event_name?: unknown }).hook_event_name
        : undefined
    })
    expect(hookEvents).toContain('SessionBusy')
    expect(hookEvents).toContain('SessionIdle')
  })

  it('maps OpenCode 2 permission.v2 events to the existing permission card contract', async () => {
    process.env.ORCA_PANE_KEY = 'tab-1:leaf-1'
    const posts: { body: Record<string, unknown> }[] = []
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The mocked fetch is assigned to the standard Fetch API shape.
    globalThis.fetch = vi.fn(async (_input: unknown, init?: { body?: unknown }) => {
      posts.push({ body: JSON.parse(String(init?.body ?? '{}')) })
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Runtime validation or the local test fixture establishes the asserted shape.
      return { ok: true } as Response
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Runtime validation or the local test fixture establishes the asserted shape.
    }) as unknown as typeof globalThis.fetch

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

    const hookEvents = posts.map((post) =>
      typeof post.body.payload === 'object' && post.body.payload !== null
        ? // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Runtime validation or the local test fixture establishes the asserted shape.
          (post.body.payload as { hook_event_name?: unknown }).hook_event_name
        : undefined
    )
    expect(hookEvents).toContain('PermissionRequest')
    expect(
      posts.find((post) => {
        const payload = post.body.payload
        return (
          typeof payload === 'object' &&
          payload !== null &&
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Runtime validation or the local test fixture establishes the asserted shape.
          (payload as { hook_event_name?: unknown }).hook_event_name === 'PermissionRequest'
        )
      })?.body
    ).toMatchObject({
      payload: {
        permission: 'bash',
        patterns: ['git status']
      }
    })
  })

  it('forwards admitted prompts and completed streamed text once', async () => {
    process.env.ORCA_PANE_KEY = 'tab-1:leaf-1'
    const posts: { body: Record<string, unknown> }[] = []
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The mocked fetch is assigned to the standard Fetch API shape.
    globalThis.fetch = vi.fn(async (_input: unknown, init?: { body?: unknown }) => {
      posts.push({ body: JSON.parse(String(init?.body ?? '{}')) })
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Runtime validation or the local test fixture establishes the asserted shape.
      return { ok: true } as Response
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Runtime validation or the local test fixture establishes the asserted shape.
    }) as unknown as typeof globalThis.fetch

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
    const posts: { body: Record<string, unknown> }[] = []
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The mocked fetch is assigned to the standard Fetch API shape.
    globalThis.fetch = vi.fn(async (_input: unknown, init?: { body?: unknown }) => {
      posts.push({ body: JSON.parse(String(init?.body ?? '{}')) })
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Runtime validation or the local test fixture establishes the asserted shape.
      return { ok: true } as Response
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Runtime validation or the local test fixture establishes the asserted shape.
    }) as unknown as typeof globalThis.fetch

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
