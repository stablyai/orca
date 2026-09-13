/**
 * Executes the generated OpenCode plugin source under an OpenCode 2 context:
 * `default.setup(ctx)` with `ctx.event.subscribe`, and asserts the V2 event
 * stream is translated into the V1 hook posts the engine has shipped for
 * OpenCode 1.x, so delivery, ownership and preview behavior carry over.
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
  app: {
    getPath: getPathMock
  }
}))

import { _internals } from './hook-service'

type V2Event = { type: string; data?: Record<string, unknown> }
type SessionFixture = { id: string; parentID?: string }
type RecordedPost = {
  url: string
  body: {
    paneKey: string
    payload: Record<string, unknown> & { hook_event_name: string }
  }
}
type PluginModule = {
  default?: {
    id?: unknown
    server?: (ctx: unknown) => Promise<unknown>
    setup?: (ctx: unknown) => Promise<(() => Promise<void>) | undefined>
  }
}

const ENV_KEYS = [
  'ORCA_PANE_KEY',
  'ORCA_AGENT_HOOK_PORT',
  'ORCA_AGENT_HOOK_TOKEN',
  'ORCA_AGENT_HOOK_ENDPOINT'
] as const

describe('OpenCode 2 plugin compatibility', () => {
  let tempDir: string
  let posts: RecordedPost[]
  let savedEnv: Record<string, string | undefined>
  let savedFetch: typeof globalThis.fetch

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'orca-opencode-v2-plugin-'))
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
    globalThis.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      posts.push({ url: String(url), body: JSON.parse(String(init?.body)) })
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

  async function loadModule(): Promise<PluginModule> {
    // Why: a unique basename per load defeats the ESM module cache between cases.
    const pluginPath = join(
      tempDir,
      `orca-opencode-status-${Math.random().toString(36).slice(2)}.mjs`
    )
    writeFileSync(pluginPath, _internals.getOpenCodePluginSource())
    return (await import(pathToFileURL(pluginPath).href)) as PluginModule
  }

  function createContext(
    events: V2Event[],
    sessions: Record<string, SessionFixture> = { root: { id: 'root' } }
  ): { ctx: unknown; finished: Promise<void> } {
    const sessionByID = new Map(Object.entries(sessions))
    let markFinished: () => void = () => {}
    const finished = new Promise<void>((resolve) => {
      markFinished = resolve
    })
    async function* stream() {
      for (const event of events) {
        yield event
      }
      markFinished()
    }
    return {
      ctx: {
        session: {
          get: async (input: { sessionID: string }) =>
            sessionByID.get(input.sessionID) ?? { id: input.sessionID }
        },
        event: { subscribe: async () => stream() }
      },
      finished
    }
  }

  function hookEventNames(): string[] {
    return posts.map((post) => post.body.payload.hook_event_name)
  }

  it('exposes setup() alongside server() on the default export', async () => {
    const module = await loadModule()

    expect(module.default?.id).toBe('orca-opencode-status')
    expect(module.default?.server).toBeTypeOf('function')
    expect(module.default?.setup).toBeTypeOf('function')
  })

  it('no-ops without throwing when the context exposes no event stream', async () => {
    const module = await loadModule()

    await expect(module.default?.setup?.({})).resolves.toBeUndefined()
    expect(posts).toEqual([])
  })

  it('maps session.status and session.idle onto SessionBusy and SessionIdle', async () => {
    const module = await loadModule()
    const { ctx, finished } = createContext([
      { type: 'session.created', data: { sessionID: 'root' } },
      { type: 'session.status', data: { sessionID: 'root', status: { type: 'busy' } } },
      { type: 'session.idle', data: { sessionID: 'root' } }
    ])

    const cleanup = await module.default?.setup?.(ctx)
    await finished
    await vi.waitFor(() => expect(hookEventNames()).toContain('SessionIdle'))

    expect(hookEventNames()).toEqual(['SessionStart', 'SessionBusy', 'SessionIdle'])
    await cleanup?.()
  })

  it('maps session.execution turn boundaries onto SessionBusy and SessionIdle', async () => {
    const module = await loadModule()
    const { ctx, finished } = createContext([
      { type: 'session.execution.started', data: { sessionID: 'root' } },
      { type: 'session.execution.succeeded', data: { sessionID: 'root' } }
    ])

    const cleanup = await module.default?.setup?.(ctx)
    await finished
    await vi.waitFor(() => expect(hookEventNames()).toContain('SessionIdle'))

    // Why: real OpenCode 2 runs do not emit session.status for ordinary turns;
    // execution.started/succeeded are the busy/idle authority.
    expect(hookEventNames()).toEqual(['SessionBusy', 'SessionIdle'])
    await cleanup?.()
  })

  it('maps session.inbox.enqueued onto a user MessagePart', async () => {
    const module = await loadModule()
    const { ctx, finished } = createContext([
      {
        type: 'session.inbox.enqueued',
        data: {
          sessionID: 'root',
          inboxID: 'inbox_1',
          item: { type: 'user', payload: { text: 'Fix the broken tests' }, delivery: 'steer' }
        }
      }
    ])

    const cleanup = await module.default?.setup?.(ctx)
    await finished
    await vi.waitFor(() => expect(hookEventNames()).toContain('MessagePart'))

    expect(posts[0]?.body.payload).toMatchObject({
      hook_event_name: 'MessagePart',
      role: 'user',
      text: 'Fix the broken tests',
      messageID: 'inbox_1',
      sessionID: 'root'
    })
    await cleanup?.()
  })

  it('maps session.text.ended onto an assistant MessagePart', async () => {
    vi.useFakeTimers()
    const module = await loadModule()
    const { ctx, finished } = createContext([
      {
        type: 'session.text.started',
        data: { sessionID: 'root', assistantMessageID: 'msg_a', ordinal: 0 }
      },
      {
        type: 'session.text.ended',
        data: { sessionID: 'root', assistantMessageID: 'msg_a', ordinal: 0, text: 'All done' }
      }
    ])

    const cleanup = await module.default?.setup?.(ctx)
    await finished
    await vi.advanceTimersByTimeAsync(1000)

    const payload = posts.find((post) => post.body.payload.hook_event_name === 'MessagePart')?.body
      .payload
    expect(payload).toMatchObject({
      role: 'assistant',
      text: 'All done',
      messageID: 'msg_a',
      sessionID: 'root'
    })
    await cleanup?.()
  })

  it('maps permission.asked onto PermissionRequest with V1 field names', async () => {
    const module = await loadModule()
    const { ctx, finished } = createContext([
      {
        type: 'permission.asked',
        data: {
          id: 'per_1',
          sessionID: 'root',
          action: 'bash',
          resources: ['rm -rf build'],
          metadata: { command: 'rm -rf build' },
          source: { type: 'tool', messageID: 'msg_1', id: 'call_1' }
        }
      }
    ])

    const cleanup = await module.default?.setup?.(ctx)
    await finished
    await vi.waitFor(() => expect(hookEventNames()).toContain('PermissionRequest'))

    const payload = posts.find((post) => post.body.payload.hook_event_name === 'PermissionRequest')
      ?.body.payload
    expect(payload).toMatchObject({
      id: 'per_1',
      sessionID: 'root',
      permission: 'bash',
      patterns: ['rm -rf build'],
      metadata: { command: 'rm -rf build' },
      always: [],
      tool: { messageID: 'msg_1', callID: 'call_1' }
    })
    await cleanup?.()
  })

  it('maps form.created onto AskUserQuestion questions', async () => {
    const module = await loadModule()
    const { ctx, finished } = createContext([
      {
        type: 'form.created',
        data: {
          form: {
            id: 'form_1',
            sessionID: 'root',
            title: 'Deploy',
            fields: [
              {
                key: 'target',
                type: 'string',
                title: 'Where should it deploy?',
                options: [{ value: 'prod', label: 'Production', description: 'Live traffic' }]
              },
              {
                key: 'extras',
                type: 'multiselect',
                title: 'Extras',
                options: [{ value: 'logs', label: 'Logs' }]
              }
            ]
          }
        }
      }
    ])

    const cleanup = await module.default?.setup?.(ctx)
    await finished
    await vi.waitFor(() => expect(hookEventNames()).toContain('AskUserQuestion'))

    const payload = posts.find((post) => post.body.payload.hook_event_name === 'AskUserQuestion')
      ?.body.payload
    expect(payload).toMatchObject({
      id: 'form_1',
      sessionID: 'root',
      questions: [
        {
          question: 'Where should it deploy?',
          header: 'Where should it deploy?',
          options: [{ label: 'Production', description: 'Live traffic' }]
        },
        {
          question: 'Extras',
          header: 'Extras',
          options: [{ label: 'Logs', description: '' }],
          multiSelect: true
        }
      ]
    })
    await cleanup?.()
  })

  it('resolves session lineage through the V2 client facade so child previews stay hidden', async () => {
    const module = await loadModule()
    const { ctx, finished } = createContext(
      [
        {
          type: 'session.text.ended',
          data: {
            sessionID: 'child',
            assistantMessageID: 'msg_child',
            ordinal: 0,
            text: 'child output'
          }
        }
      ],
      { root: { id: 'root' }, child: { id: 'child', parentID: 'root' } }
    )

    const cleanup = await module.default?.setup?.(ctx)
    await finished

    // Why: child-session text must not replace the root pane preview; the V2
    // context's session.get has to answer the engine's lineage walk for that.
    expect(hookEventNames()).not.toContain('MessagePart')
    await cleanup?.()
  })

  it('does not post SessionStart for a child session.created', async () => {
    const module = await loadModule()
    const { ctx, finished } = createContext(
      [{ type: 'session.created', data: { sessionID: 'child', parentID: 'root' } }],
      { root: { id: 'root' }, child: { id: 'child', parentID: 'root' } }
    )

    const cleanup = await module.default?.setup?.(ctx)
    await finished

    // Why: the V2 session.created payload carries parentID flat; a child session
    // must not seed rootSessionById, or child suppression stops working.
    expect(hookEventNames()).toEqual([])
    await cleanup?.()
  })

  it('clears a pending question on form.replied', async () => {
    const form = {
      id: 'form_1',
      sessionID: 'root',
      title: 'Deploy',
      fields: [{ key: 'target', type: 'string', title: 'Target' }]
    }

    const module = await loadModule()
    const { ctx, finished } = createContext([
      { type: 'form.created', data: { form } },
      {
        type: 'form.replied',
        data: { id: 'form_1', sessionID: 'root', answer: { target: 'prod' } }
      }
    ])
    const cleanup = await module.default?.setup?.(ctx)
    await finished
    await vi.waitFor(() => expect(hookEventNames()).toContain('SessionIdle'))

    expect(hookEventNames()).toEqual(['AskUserQuestion', 'SessionIdle'])
    await cleanup?.()
  })

  it('clears a pending question when the resolution id arrives as requestID', async () => {
    const form = {
      id: 'form_1',
      sessionID: 'root',
      title: 'Deploy',
      fields: [{ key: 'target', type: 'string', title: 'Target' }]
    }

    const module = await loadModule()
    const { ctx, finished } = createContext([
      { type: 'form.created', data: { form } },
      // Why: pins the hedge — a resolution whose id arrives as requestID must
      // still retire the blocker instead of leaving the row waiting.
      { type: 'form.cancelled', data: { requestID: 'form_1', sessionID: 'root' } }
    ])
    const cleanup = await module.default?.setup?.(ctx)
    await finished
    await vi.waitFor(() => expect(hookEventNames()).toContain('SessionIdle'))

    expect(hookEventNames()).toEqual(['AskUserQuestion', 'SessionIdle'])
    await cleanup?.()
  })
})
