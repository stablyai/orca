import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const { getPathMock } = vi.hoisted(() => ({
  getPathMock: vi.fn<(name: string) => string>()
}))

vi.mock('electron', () => ({ app: { getPath: getPathMock } }))

import { _internals } from './hook-service'

// Why: live probe of opencode v2.0.12 — session.get resolves the session record
// itself (no { data } envelope), rejects the legacy { path: { id } } argument,
// and session.list does not exist. Anything less faithful hides the defect.
type LiveSession = { id: string; parentID?: string }

const ROOT = 'ses_root'
const CHILD = 'ses_child'
const LIVE_SESSIONS: Record<string, LiveSession> = {
  [ROOT]: { id: ROOT },
  [CHILD]: { id: CHILD, parentID: ROOT }
}

type Post = { hook_event_name: string; sessionID?: string }

const ENV_KEYS = [
  'ORCA_PANE_KEY',
  'ORCA_OPENCODE_AGENT',
  'ORCA_AGENT_HOOK_ENDPOINT',
  'ORCA_AGENT_HOOK_PORT',
  'ORCA_AGENT_HOOK_TOKEN'
] as const

describe.each(['opencode', 'opencode2'] as const)('%s plugin OpenCode 2 lineage', (agent) => {
  let tempDir: string
  let savedFetch: typeof globalThis.fetch
  let savedEnv: Record<string, string | undefined>

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'orca-opencode2-lineage-'))
    savedFetch = globalThis.fetch
    savedEnv = {}
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key]
    }
    process.env.ORCA_PANE_KEY = 'tab-1:leaf-1'
    process.env.ORCA_OPENCODE_AGENT = agent
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

  async function loadPlugin(): Promise<{
    default?: {
      server?: (ctx: unknown) => Promise<{ event: (input: { event: unknown }) => Promise<void> }>
      setup?: (ctx: unknown) => Promise<() => Promise<void>>
    }
  }> {
    const source =
      agent === 'opencode2'
        ? _internals.getOpenCode2PluginSource()
        : _internals.getOpenCodePluginSource()
    const pluginPath = join(tempDir, `plugin-${Math.random().toString(36).slice(2)}.mjs`)
    writeFileSync(pluginPath, source)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the local fixture module is written from the generated plugin source above.
    return (await import(pathToFileURL(pluginPath).href)) as Awaited<ReturnType<typeof loadPlugin>>
  }

  async function runSetupBridge(
    events: { type: string; data: Record<string, unknown> }[],
    failSessionIDs: ReadonlySet<string> = new Set()
  ): Promise<{
    posts: Post[]
    lookups: string[]
    cleanup?: () => Promise<void>
  }> {
    const posts: Post[] = []
    const lookups: string[] = []
    globalThis.fetch = vi.fn(async (_input, init) => {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the plugin always posts a JSON body carrying `payload`.
      const body = JSON.parse(String(init?.body)) as { payload: Post }
      posts.push(body.payload)
      return new Response('{}', { status: 200 })
    })
    const module = await loadPlugin()
    const cleanup = await module.default?.setup?.({
      session: {
        // Why: one declared parameter, exactly like the shipped SDK method.
        get: async ({ sessionID }: { sessionID?: string }) => {
          if (!sessionID) {
            throw new Error('Missing key at ["sessionID"]')
          }
          lookups.push(sessionID)
          if (failSessionIDs.has(sessionID)) {
            throw new Error('session lookup unavailable')
          }
          const session = LIVE_SESSIONS[sessionID]
          if (!session) {
            throw new Error('unknown session')
          }
          return session
        },
        hook: async () => ({ dispose: vi.fn() })
      },
      event: {
        subscribe: async function* () {
          for (const event of events) {
            yield event
          }
        }
      }
    })
    return { posts, lookups, cleanup }
  }

  function created(sessionID: string): { type: string; data: Record<string, unknown> } {
    const { parentID } = LIVE_SESSIONS[sessionID]
    return { type: 'session.created', data: { sessionID, ...(parentID ? { parentID } : {}) } }
  }

  function questionForm(id: string, sessionID: string): Record<string, unknown> {
    return {
      id,
      sessionID,
      title: 'Questions',
      metadata: { kind: 'question', tool: { messageID: 'msg-0', id: 'tool-0' } },
      fields: [{ key: 'q0', title: 'Proceed?', type: 'string', options: [] }]
    }
  }

  it('resolves child lineage from the flat OpenCode 2 session shape', async () => {
    const { posts, lookups, cleanup } = await runSetupBridge([
      created(ROOT),
      created(CHILD),
      { type: 'session.execution.started', data: { sessionID: ROOT } },
      { type: 'session.execution.started', data: { sessionID: CHILD } }
    ])
    await vi.waitFor(() => {
      expect(posts.filter((post) => post.hook_event_name === 'SessionBusy').length).toBeGreaterThan(
        0
      )
    })
    // The child rolls up under its root; it never publishes as a root itself.
    expect(posts.map((post) => post.sessionID)).not.toContain(CHILD)
    expect(lookups).toContain(CHILD)
    await cleanup?.()
  })

  it('attributes a child question to the root instead of minting a child blocker', async () => {
    const { posts, cleanup } = await runSetupBridge([
      created(ROOT),
      created(CHILD),
      { type: 'session.execution.started', data: { sessionID: ROOT } },
      { type: 'form.created', data: { form: questionForm('form-child', CHILD) } }
    ])
    await vi.waitFor(() => {
      expect(posts.map((post) => post.hook_event_name)).toContain('AskUserQuestion')
    })
    expect(posts.filter((post) => post.hook_event_name === 'AskUserQuestion')).toEqual([
      expect.objectContaining({ sessionID: ROOT })
    ])
    await cleanup?.()
  })

  it('retires a child raised blocker when that child goes idle', async () => {
    const { posts, cleanup } = await runSetupBridge([
      created(ROOT),
      created(CHILD),
      { type: 'session.execution.started', data: { sessionID: ROOT } },
      { type: 'form.created', data: { form: questionForm('form-child', CHILD) } },
      { type: 'session.execution.succeeded', data: { sessionID: CHILD } }
    ])
    await vi.waitFor(() => {
      expect(posts.map((post) => post.hook_event_name)).toContain('AskUserQuestion')
    })
    // The root turn is still running, so the pane goes back to busy rather than staying blocked.
    await vi.waitFor(() => {
      expect(posts.at(-1)?.hook_event_name).toBe('SessionBusy')
    })
    expect(posts.at(-1)).toEqual(expect.objectContaining({ sessionID: ROOT }))
    await cleanup?.()
  })

  // Why this case: it is the shape reported in #22371 — a subagent asks, the lead
  // agent truthfully reports no pending question, and the pane stays "needs input"
  // with nothing able to clear it. With lineage unresolved the blocker keys to the
  // child's own session id, so the root's own idle never matches it.
  it('retires a child raised blocker when the root turn goes idle', async () => {
    const { posts, cleanup } = await runSetupBridge([
      created(ROOT),
      created(CHILD),
      { type: 'session.execution.started', data: { sessionID: ROOT } },
      { type: 'form.created', data: { form: questionForm('form-child', CHILD) } },
      { type: 'session.execution.succeeded', data: { sessionID: ROOT } }
    ])
    await vi.waitFor(() => {
      expect(posts.map((post) => post.hook_event_name)).toContain('AskUserQuestion')
    })
    await vi.waitFor(() => {
      expect(posts.at(-1)?.hook_event_name).toBe('SessionIdle')
    })
    expect(posts.at(-1)).toEqual(expect.objectContaining({ sessionID: ROOT }))
    await cleanup?.()
  })

  // Why this case: the root's resolved ancestry is evictable — rootSessionById caps
  // at 128 and a live blocker does not pin it — so a long-lived OpenCode process can
  // drop the root mapping. If the root's idle then re-looks it up while the SDK is
  // failing, control reaches the unknown-lineage branch; the blocker rolled up from
  // the child must still retire there, or the pane stays blocked after the turn.
  it('retires a root displayed child blocker when the root idle cannot resolve lineage', async () => {
    const fillerSessions = Array.from({ length: 130 }, (_, index) => ({
      type: 'session.created',
      data: { sessionID: `ses_filler_${index}` }
    }))
    const { posts, cleanup } = await runSetupBridge(
      [
        created(ROOT),
        created(CHILD),
        { type: 'session.execution.started', data: { sessionID: ROOT } },
        { type: 'form.created', data: { form: questionForm('form-child', CHILD) } },
        ...fillerSessions,
        { type: 'session.execution.succeeded', data: { sessionID: ROOT } }
      ],
      new Set([ROOT])
    )
    await vi.waitFor(() => {
      expect(posts.map((post) => post.hook_event_name)).toContain('AskUserQuestion')
    })
    await vi.waitFor(() => {
      expect(posts.at(-1)?.hook_event_name).toBe('SessionIdle')
    })
    expect(posts.at(-1)).toEqual(expect.objectContaining({ sessionID: ROOT }))
    await cleanup?.()
  })

  it('still blocks the pane on the root session own question', async () => {
    const { posts, cleanup } = await runSetupBridge([
      created(ROOT),
      { type: 'session.execution.started', data: { sessionID: ROOT } },
      { type: 'form.created', data: { form: questionForm('form-root', ROOT) } }
    ])
    await vi.waitFor(() => {
      expect(posts.map((post) => post.hook_event_name)).toContain('AskUserQuestion')
    })
    expect(posts.at(-1)).toEqual(expect.objectContaining({ sessionID: ROOT }))
    await cleanup?.()
  })

  it('caches resolved ancestry instead of re-probing per event', async () => {
    const { posts, lookups, cleanup } = await runSetupBridge([
      created(ROOT),
      created(CHILD),
      { type: 'session.execution.started', data: { sessionID: CHILD } },
      { type: 'session.execution.succeeded', data: { sessionID: CHILD } },
      { type: 'session.execution.started', data: { sessionID: CHILD } },
      { type: 'session.execution.succeeded', data: { sessionID: CHILD } }
    ])
    await vi.waitFor(() => {
      expect(posts.length).toBeGreaterThan(0)
    })
    // The root arrived via session.created, so only the child needs one lookup.
    expect(lookups).toEqual([CHILD])
    await cleanup?.()
  })
})

describe('OpenCode 2 session client shim', () => {
  it('keeps the enveloped SDK result untouched for the OpenCode 1 server path', () => {
    const source = _internals.getOpenCodePluginSource()

    // The shim only wraps a bare session record; server() still hands the raw SDK client through.
    expect(source).toContain(
      'return result && typeof result.id === "string" ? { data: result } : result;'
    )
    expect(source).toContain(
      'handleLifecycleEvent(client, normalizeNextLifecycleEvent(event), factoryID)'
    )
    expect(source).toContain('const client = _ctx?.client;')
  })
})
