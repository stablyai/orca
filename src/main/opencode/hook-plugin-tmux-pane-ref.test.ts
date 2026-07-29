/**
 * Executes the generated OpenCode plugin source because the tmux pane it reports
 * is resolved inside OpenCode's process, not in Orca's TypeScript runtime.
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
type PluginEventHandler = (input: { event: PluginEvent }) => Promise<void>
type PluginHooks = { event: PluginEventHandler; dispose?: () => Promise<void> }
type RecordedBody = { paneKey: string; tmuxPaneRef?: string }

const ENV_KEYS = [
  'ORCA_PANE_KEY',
  'ORCA_AGENT_HOOK_PORT',
  'ORCA_AGENT_HOOK_TOKEN',
  'ORCA_AGENT_HOOK_ENDPOINT',
  'TMUX',
  'TMUX_PANE'
] as const

describe('OpenCode plugin tmux pane ref', () => {
  let tempDir: string
  let bodies: RecordedBody[]
  let savedEnv: Record<string, string | undefined>
  let savedFetch: typeof globalThis.fetch

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'orca-opencode-tmux-pane-plugin-'))
    bodies = []
    savedEnv = {}
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key]
    }
    process.env.ORCA_PANE_KEY = 'tab-1:leaf-1'
    process.env.ORCA_AGENT_HOOK_PORT = '45678'
    process.env.ORCA_AGENT_HOOK_TOKEN = 'test-token'
    delete process.env.ORCA_AGENT_HOOK_ENDPOINT
    delete process.env.TMUX
    delete process.env.TMUX_PANE
    savedFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as RecordedBody)
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

  async function postBusy(): Promise<RecordedBody> {
    const pluginPath = join(tempDir, 'orca-opencode-status.mjs')
    writeFileSync(pluginPath, _internals.getOpenCodePluginSource())
    const module = (await import(pathToFileURL(pluginPath).href)) as {
      OrcaOpenCodeStatusPlugin: (ctx: unknown) => Promise<PluginHooks>
    }
    const hooks = await module.OrcaOpenCodeStatusPlugin({
      client: { session: { list: async () => ({ data: [{ id: 'root' }] }) } }
    })
    await hooks.event({
      event: {
        type: 'session.status',
        properties: { sessionID: 'root', status: { type: 'busy' } }
      }
    })
    const [body] = bodies
    if (!body) {
      throw new Error('plugin did not post a status')
    }
    return body
  }

  it('reports socket-qualified pane id when running inside tmux', async () => {
    process.env.TMUX = '/private/tmp/tmux-501/default,4242,0'
    process.env.TMUX_PANE = '%3'

    // Why: sibling panes share ORCA_PANE_KEY, so this ref is the only thing
    // that tells two agents under one outer pane apart.
    expect(await postBusy()).toMatchObject({
      paneKey: 'tab-1:leaf-1',
      tmuxPaneRef: '/private/tmp/tmux-501/default:%3'
    })
  })

  it('keeps pane ids from separate tmux servers distinct', async () => {
    process.env.TMUX = '/private/tmp/tmux-501/other,4243,0'
    process.env.TMUX_PANE = '%3'

    expect((await postBusy()).tmuxPaneRef).toBe('/private/tmp/tmux-501/other:%3')
  })

  it('falls back to the bare pane id when TMUX is unset', async () => {
    process.env.TMUX_PANE = '%7'

    expect((await postBusy()).tmuxPaneRef).toBe('%7')
  })

  it('reports no pane ref outside tmux', async () => {
    expect(await postBusy()).toMatchObject({ paneKey: 'tab-1:leaf-1', tmuxPaneRef: '' })
  })
})
