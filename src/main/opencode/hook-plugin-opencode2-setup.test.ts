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
describe('OpenCode 2 setup and prompt ordering', () => {
  type PostBody = { payload?: unknown }

  function record(value: unknown): Record<string, unknown> | undefined {
    return typeof value === 'object' && value !== null
      ? Object.fromEntries(Object.entries(value))
      : undefined
  }

  function payload(body: PostBody): Record<string, unknown> {
    return record(body.payload) ?? {}
  }

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

  it('subscribes through the OpenCode 2 setup API and disposes its registrations', async () => {
    process.env.ORCA_PANE_KEY = 'tab-1:leaf-1'
    const posts: unknown[] = []
    globalThis.fetch = vi.fn(async (_input, init) => {
      posts.push(JSON.parse(String(init?.body)))
      return new Response('{}', { status: 200 })
    })
    const dispose = vi.fn()
    let subscriptionSignal: AbortSignal | undefined
    const module = await loadPluginModule(_internals.getOpenCode2PluginSource())
    expect(module.default?.setup).toBeTypeOf('function')
    const cleanup = await module.default?.setup?.({
      session: {
        get: async ({ sessionID }: { sessionID: string }) => ({ data: { id: sessionID } }),
        hook: async () => ({ dispose })
      },
      event: {
        subscribe: async function* ({ signal }: { signal: AbortSignal }) {
          subscriptionSignal = signal
          yield { type: 'session.created', data: { sessionID: 'ses_root' } }
          yield {
            type: 'session.execution.started',
            data: { sessionID: 'ses_root' }
          }
          yield {
            type: 'session.execution.succeeded',
            data: { sessionID: 'ses_root' }
          }
        }
      }
    })
    await vi.waitFor(() => {
      expect(posts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            payload: expect.objectContaining({ hook_event_name: 'SessionBusy' })
          }),
          expect.objectContaining({
            payload: expect.objectContaining({ hook_event_name: 'SessionIdle' })
          })
        ])
      )
    })
    await cleanup?.()
    expect(dispose).toHaveBeenCalledOnce()
    expect(subscriptionSignal?.aborted).toBe(true)
  })

  it('maps permission, form, and text events through the live setup bridge', async () => {
    process.env.ORCA_PANE_KEY = 'tab-1:leaf-1'
    const posts: { body: PostBody }[] = []
    globalThis.fetch = vi.fn(async (_input, init) => {
      posts.push({ body: record(JSON.parse(String(init?.body))) ?? {} })
      return new Response('{}', { status: 200 })
    })
    const module = await loadPluginModule(_internals.getOpenCode2PluginSource())
    const cleanup = await module.default?.setup?.({
      session: {
        get: async ({ sessionID }: { sessionID: string }) => ({ data: { id: sessionID } }),
        hook: async () => ({ dispose: vi.fn() })
      },
      event: {
        subscribe: async function* () {
          yield {
            type: 'permission.asked',
            data: { id: 'perm-1', sessionID: 'ses_root', action: 'bash', resources: ['pwd'] }
          }
          yield {
            type: 'permission.replied',
            data: { id: 'perm-1', requestID: 'perm-1', sessionID: 'ses_root' }
          }
          yield {
            type: 'form.created',
            data: {
              form: {
                id: 'form-1',
                sessionID: 'ses_root',
                title: 'Pick',
                fields: [
                  {
                    title: 'Color',
                    description: 'Choose',
                    type: 'string',
                    options: [{ label: 'Red', value: 'red' }]
                  }
                ]
              }
            }
          }
          yield {
            type: 'session.text.started',
            data: { sessionID: 'ses_root', assistantMessageID: 'msg-1' }
          }
          yield {
            type: 'session.text.delta',
            data: { sessionID: 'ses_root', assistantMessageID: 'msg-1', delta: 'hello' }
          }
          yield {
            type: 'session.text.ended',
            data: { sessionID: 'ses_root', assistantMessageID: 'msg-1', text: 'hello' }
          }
          yield { type: 'form.cancelled', data: { id: 'form-1', sessionID: 'ses_root' } }
        }
      }
    })
    await vi.waitFor(() => {
      const names = posts.map(({ body }) => payload(body).hook_event_name)
      expect(names).toEqual(expect.arrayContaining(['PermissionRequest', 'MessagePart']))
    })
    await vi.waitFor(() => {
      const names = posts.map(({ body }) => payload(body).hook_event_name)
      expect(names).toContain('AskUserQuestion')
      expect(posts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            body: expect.objectContaining({
              payload: expect.objectContaining({
                hook_event_name: 'AskUserQuestion',
                sessionID: 'ses_root'
              })
            })
          })
        ])
      )
    })
    await vi.waitFor(() => {
      const names = posts.map(({ body }) => payload(body).hook_event_name)
      expect(names.at(-1)).toBe('SessionIdle')
    })
    await cleanup?.()
  })

  it.each(['waiting', 'idle', 'disposed'])(
    'drops an admitted prompt overtaken by %s',
    async (transition) => {
      process.env.ORCA_PANE_KEY = 'tab-1:leaf-1'
      const posts: unknown[] = []
      globalThis.fetch = vi.fn(async (_input, init) => {
        posts.push(JSON.parse(String(init?.body)))
        return new Response('{}', { status: 200 })
      })
      let releaseLookup: (value: { data: { id: string } }) => void = () => {}
      const lookup = new Promise<{ data: { id: string } }>((resolve) => {
        releaseLookup = resolve
      })
      const module = await loadPluginModule(_internals.getOpenCode2PluginSource())
      const hooks = await module.default?.server?.({ client: { session: { get: () => lookup } } })
      expect(hooks).toBeDefined()
      const prompt = hooks?.event({
        event: {
          type: 'session.next.prompt.admitted',
          properties: {
            sessionID: 'ses_root',
            messageID: 'msg_user',
            prompt: { text: 'stale prompt' }
          }
        }
      })
      if (transition === 'disposed') {
        await hooks?.dispose?.()
      } else {
        // Seed ancestry while the earlier prompt lookup remains suspended.
        await hooks?.event({
          event: { type: 'session.created', properties: { info: { id: 'ses_root' } } }
        })
        await hooks?.event({
          event:
            transition === 'waiting'
              ? {
                  type: 'permission.asked',
                  properties: {
                    id: 'perm_1',
                    sessionID: 'ses_root',
                    permission: 'bash',
                    patterns: ['sleep 25']
                  }
                }
              : { type: 'session.idle', properties: { sessionID: 'ses_root' } }
        })
      }
      releaseLookup({ data: { id: 'ses_root' } })
      await prompt
      expect(posts).not.toContainEqual(
        expect.objectContaining({ payload: expect.objectContaining({ role: 'user' }) })
      )
      await hooks?.dispose?.()
    }
  )
})
