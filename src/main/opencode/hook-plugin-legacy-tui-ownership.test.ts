import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { getOpenCodePluginSource } from './status-plugin-module-source'
import { writeOpenCodeTuiPlugin } from '../../shared/opencode-tui-plugin-install'
import { fakeLegacyTui, type LegacyTuiEvent } from './opencode-legacy-tui-fixture'
import { getLegacyPlugins, readV1Plugin } from './opencode-legacy-plugin-loader-fixture'
import { getOpenCodeCliCapabilities } from '../../shared/opencode-cli-version'

type Post = {
  paneKey?: string
  opencodeMajor?: number
  opencodeTui?: number
  opencodeSharedServer?: number
  payload?: { hook_event_name?: string; sessionID?: string; role?: string; text?: string }
}
const PANE_A = 'tabA:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const PANE_B = 'tabB:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const ENV_KEYS = [
  'ORCA_PANE_KEY',
  'ORCA_OPENCODE_AGENT',
  'ORCA_AGENT_HOOK_ENDPOINT',
  'ORCA_AGENT_HOOK_PORT',
  'ORCA_AGENT_HOOK_TOKEN',
  'ORCA_AGENT_HOOK_OPENCODE_TUI',
  'ORCA_OPENCODE_PLUGIN_API'
] as const
const created = (id: string, parentID?: string): LegacyTuiEvent => ({
  type: 'session.created',
  properties: { info: { id, parentID, directory: '/same-folder' } }
})
const status = (sessionID: string, type: string): LegacyTuiEvent => ({
  type: 'session.status',
  properties: { sessionID, status: { type } }
})

describe('OpenCode 1 TUI API pane reporting', () => {
  let dir: string
  let posts: Post[]
  let savedFetch: typeof fetch
  let savedArgv: string[]
  let savedEnv: Record<string, string | undefined>
  const cleanups: (() => Promise<void>)[] = []

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orca-legacy-tui-'))
    savedFetch = globalThis.fetch
    savedArgv = process.argv
    savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))
    process.argv = ['opencode', 'attach', 'http://127.0.0.1:4096']
    process.env.ORCA_OPENCODE_PLUGIN_API = 'v2'
    process.env.ORCA_OPENCODE_AGENT = 'opencode'
    process.env.ORCA_AGENT_HOOK_PORT = '59999'
    process.env.ORCA_AGENT_HOOK_TOKEN = 'fixture'
    process.env.ORCA_AGENT_HOOK_OPENCODE_TUI = '1'
    delete process.env.ORCA_AGENT_HOOK_ENDPOINT
    posts = []
    globalThis.fetch = vi.fn(async (_input, init) => {
      posts.push(JSON.parse(String(init?.body)))
      return new Response('{}', { status: 200 })
    })
  })

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) {
      await cleanup()
    }
    globalThis.fetch = savedFetch
    process.argv = savedArgv
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = savedEnv[key]
      }
    }
    rmSync(dir, { recursive: true, force: true })
  })

  async function start(paneKey = PANE_A, tui = fakeLegacyTui()) {
    process.env.ORCA_PANE_KEY = paneKey
    const name = `orca-status-${Math.random().toString(36).slice(2)}.js`
    writeOpenCodeTuiPlugin(dir, name, getOpenCodePluginSource())
    const plugin: unknown = await import(
      pathToFileURL(join(dir, name.replace(/\.js$/, '-tui'), 'tui.js')).href
    )
    if (typeof plugin !== 'object' || !plugin || !('default' in plugin)) {
      throw new Error('No plugin')
    }
    const entry = readV1Plugin(plugin, name, 'tui')
    expect(entry).not.toHaveProperty('server')
    expect(entry).toHaveProperty('setup', expect.any(Function))
    if (
      typeof entry !== 'object' ||
      !entry ||
      !('tui' in entry) ||
      typeof entry.tui !== 'function'
    ) {
      throw new Error('No TUI entry')
    }
    await entry.tui(tui.api)
    cleanups.push(() => tui.dispose())
    return tui
  }

  const names = () =>
    posts.map((post) => `${post.payload?.hook_event_name}:${post.payload?.sessionID}`)
  const settle = async (name: string) => vi.waitFor(() => expect(names().at(-1)).toBe(name))
  async function pump(tui: ReturnType<typeof fakeLegacyTui>, events: LegacyTuiEvent[]) {
    for (const event of events) {
      tui.emit(event)
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }

  it('registers a separate object TUI entry while retaining the current server entry', async () => {
    process.env.ORCA_PANE_KEY = PANE_A
    const path = join(dir, 'server.mjs')
    writeFileSync(path, getOpenCodePluginSource())
    const plugin: unknown = await import(pathToFileURL(path).href)
    expect(plugin).toMatchObject({
      default: { server: expect.any(Function), setup: expect.any(Function) },
      OrcaOpenCodeStatusPlugin: expect.any(Function)
    })
    if (typeof plugin !== 'object' || !plugin || !('default' in plugin)) {
      throw new Error('No server plugin')
    }
    expect(readV1Plugin(plugin, path, 'server')).not.toHaveProperty('tui')
    const tui = await start()
    expect(tui.listenerCount()).toBeGreaterThan(0)
  })

  it('loads the selected v1 factory through the release fallback once and retains the separate TUI', async () => {
    process.env.ORCA_OPENCODE_PLUGIN_API = getOpenCodeCliCapabilities('1.18.30').pluginApi
    process.argv = ['opencode', 'serve']
    process.env.ORCA_PANE_KEY = PANE_A
    const path = join(dir, 'selected-v1-server.mjs')
    writeFileSync(path, getOpenCodePluginSource())
    const plugin: unknown = await import(pathToFileURL(path).href)
    if (typeof plugin !== 'object' || !plugin || !('default' in plugin)) {
      throw new Error('No server plugin')
    }
    expect(readV1Plugin(plugin, path, 'server', 'detect')).toBeUndefined()
    const factories = getLegacyPlugins(plugin)
    expect(factories).toHaveLength(1)
    expect(factories[0]).toBe(plugin.default)
    const hooks: unknown = await factories[0]({
      client: { session: { get: async () => ({ data: { id: 'ses_root' } }) } }
    })
    if (
      !hooks ||
      typeof hooks !== 'object' ||
      !('event' in hooks) ||
      typeof hooks.event !== 'function' ||
      !('dispose' in hooks) ||
      typeof hooks.dispose !== 'function'
    ) {
      throw new Error('No legacy event hooks')
    }
    const dispose = hooks.dispose
    cleanups.push(async () => {
      await dispose()
    })
    await hooks.event({
      event: {
        type: 'session.status',
        properties: { sessionID: 'ses_root', status: { type: 'busy' } }
      }
    })
    await settle('SessionBusy:ses_root')
    expect(posts.at(-1)).toMatchObject({ opencodeSharedServer: 1 })
    process.argv = ['opencode', 'attach', 'http://127.0.0.1:4096']
    const tui = await start()
    expect(tui.listenerCount()).toBeGreaterThan(0)
  })

  it('reproduces the release loader rejection of a combined server and TUI entry', () => {
    expect(() =>
      readV1Plugin({ default: { server() {}, tui() {} } }, 'orca-opencode-status-tui/tui.js', 'tui')
    ).toThrow('must default export either server() or tui(), not both')
  })

  it('keeps legacy reporting after the release catalog probes setup in the same module', async () => {
    process.argv = ['opencode', 'serve']
    process.env.ORCA_PANE_KEY = PANE_A
    const path = join(dir, 'catalog-probed-server.mjs')
    writeFileSync(path, getOpenCodePluginSource())
    const plugin: unknown = await import(pathToFileURL(path).href)
    if (typeof plugin !== 'object' || !plugin || !('default' in plugin)) {
      throw new Error('No server plugin')
    }
    const entry = readV1Plugin(plugin, path, 'server')
    if (!entry || typeof entry.setup !== 'function' || typeof entry.server !== 'function') {
      throw new Error('No setup and server entry')
    }
    // OpenCode 1.18.30's catalog adapter probes setup before its legacy server loads.
    const cleanup = await entry.setup({ options: {}, catalog: {} })
    expect(cleanup).toBeTypeOf('function')
    const hooks = await entry.server({
      client: { session: { get: async () => ({ data: { id: 'ses_root' } }) } }
    })
    if (!hooks || typeof hooks.event !== 'function' || typeof hooks.dispose !== 'function') {
      throw new Error('No legacy event hooks')
    }
    cleanups.push(() => hooks.dispose())
    await hooks.event({
      event: {
        type: 'session.status',
        properties: { sessionID: 'ses_root', status: { type: 'busy' } }
      }
    })
    await settle('SessionBusy:ses_root')
    expect(posts.at(-1)).toMatchObject({ opencodeSharedServer: 1 })
    expect(posts.at(-1)).not.toHaveProperty('opencodeMajor')
  })

  it('reports only the selected pane session on a same-folder shared event bus', async () => {
    const bus = [
      created('ses_a'),
      status('ses_a', 'busy'),
      created('ses_b'),
      status('ses_b', 'busy'),
      status('ses_b', 'idle'),
      status('ses_a', 'idle')
    ]
    for (const [pane, session] of [
      [PANE_A, 'ses_a'],
      [PANE_B, 'ses_b']
    ] as const) {
      const from = posts.length
      const tui = await start(pane)
      tui.navigate(session)
      await pump(tui, bus)
      await settle(`SessionIdle:${session}`)
      const own = posts.slice(from)
      expect(new Set(own.map((post) => post.payload?.sessionID))).toEqual(new Set([session]))
      expect(
        own.every(
          (post) =>
            post.paneKey === pane && post.opencodeTui === 1 && post.opencodeMajor === undefined
        )
      ).toBe(true)
      await tui.dispose()
    }
  })

  it('keeps the original running root after navigation and ignores sibling completion', async () => {
    const tui = await start()
    tui.navigate('ses_a')
    await pump(tui, [created('ses_a'), status('ses_a', 'busy')])
    tui.navigate('ses_b')
    await pump(tui, [created('ses_b'), status('ses_b', 'idle')])
    expect(names().at(-1)).toBe('SessionBusy:ses_a')
    await pump(tui, [status('ses_a', 'idle')])
    await settle('SessionIdle:ses_a')
  })

  it('uses message session identity and leaves synthetic text out of the pane preview', async () => {
    const tui = await start()
    tui.navigate('ses_a')
    await pump(tui, [created('ses_a'), status('ses_a', 'busy')])
    await settle('SessionBusy:ses_a')
    const count = posts.length
    const part = { type: 'text', messageID: 'msg_user', sessionID: 'ses_a', text: 'Synthetic task' }
    await pump(tui, [
      {
        type: 'message.updated',
        properties: { info: { id: 'msg_user', sessionID: 'ses_a', role: 'user' } }
      },
      { type: 'message.part.updated', properties: { part: { ...part, synthetic: true } } }
    ])
    expect(posts).toHaveLength(count)
    await pump(tui, [
      { type: 'message.part.updated', properties: { part: { ...part, text: 'Real prompt' } } }
    ])
    await settle('MessagePart:ses_a')
    expect(posts.at(-1)?.payload).toMatchObject({
      role: 'user',
      text: 'Real prompt',
      messageID: 'msg_user',
      sessionID: 'ses_a'
    })
  })

  it.each(['permission', 'question'])(
    'reports a child %s under its owned root and clears the reply',
    async (kind) => {
      const tui = await start()
      tui.navigate('ses_a')
      await pump(tui, [
        created('ses_a'),
        created('ses_child', 'ses_a'),
        status('ses_a', 'busy'),
        status('ses_child', 'busy')
      ])
      await pump(tui, [
        {
          type: `${kind}.asked`,
          properties: { id: 'request_1', sessionID: 'ses_child', permission: 'bash', questions: [] }
        }
      ])
      await settle(`${kind === 'permission' ? 'PermissionRequest' : 'AskUserQuestion'}:ses_a`)
      await pump(tui, [
        { type: `${kind}.replied`, properties: { requestID: 'request_1', sessionID: 'ses_child' } },
        status('ses_child', 'idle'),
        status('ses_a', 'idle')
      ])
      await settle('SessionIdle:ses_a')
      expect(posts.every((post) => post.payload?.sessionID === 'ses_a')).toBe(true)
    }
  )

  it('keeps newer hosts capability opt-in separate from the process environment', async () => {
    const endpoint = join(dir, 'endpoint.env')
    process.env.ORCA_AGENT_HOOK_ENDPOINT = endpoint
    writeFileSync(endpoint, 'ORCA_AGENT_HOOK_PORT=59999\nORCA_AGENT_HOOK_TOKEN=fixture\n')
    const tui = await start()
    tui.navigate('ses_a')
    await pump(tui, [created('ses_a'), status('ses_a', 'busy')])
    expect(posts).toEqual([])
    writeFileSync(
      endpoint,
      'ORCA_AGENT_HOOK_PORT=59999\nORCA_AGENT_HOOK_TOKEN=fixture\nORCA_AGENT_HOOK_OPENCODE_TUI=1\n'
    )
    await settle('SessionBusy:ses_a')
  })

  it('stops its listeners and publishes no invented Idle when its TUI is unloaded', async () => {
    const tui = await start()
    tui.navigate('ses_a')
    await pump(tui, [created('ses_a'), status('ses_a', 'busy')])
    await settle('SessionBusy:ses_a')
    await tui.dispose()
    expect(tui.listenerCount()).toBe(0)
    const count = posts.length
    await pump(tui, [status('ses_a', 'idle')])
    expect(posts).toHaveLength(count)
  })

  it.each(['ordinary', 'other-agent', 'no-pane', 'wrong-version'])(
    'stays silent for %s',
    async (kind) => {
      const tui = fakeLegacyTui()
      if (kind === 'ordinary') {
        process.argv = ['opencode']
      }
      if (kind === 'other-agent') {
        process.env.ORCA_OPENCODE_AGENT = 'mimo-code'
      }
      if (kind === 'wrong-version') {
        tui.api.app.version = '2.0.16'
      }
      await start(kind === 'no-pane' ? '' : PANE_A, tui)
      expect(tui.on).not.toHaveBeenCalled()
      expect(posts).toEqual([])
    }
  )
})
