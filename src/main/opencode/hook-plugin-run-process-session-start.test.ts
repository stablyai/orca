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

type PluginHooks = {
  event: (input: { event: { type: string; properties?: unknown } }) => Promise<void>
}
type PluginModule = { OrcaOpenCodeStatusPlugin?: (ctx: unknown) => Promise<PluginHooks> }

const ENV_KEYS = ['ORCA_PANE_KEY', 'ORCA_AGENT_HOOK_PORT', 'ORCA_AGENT_HOOK_TOKEN'] as const

// OpenCode 1 `run` loads the plugin in-process; the host already shows the run as Working from the
// process, so a session-start idle row there would only blink the pane.
describe('OpenCode plugin session start inside a `run` process', () => {
  let tempDir: string
  let events: string[]
  let savedEnv: Record<string, string | undefined>
  let savedArgv: string[]
  let savedFetch: typeof globalThis.fetch

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'orca-opencode-run-process-'))
    events = []
    savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))
    savedArgv = process.argv
    savedFetch = globalThis.fetch
    process.env.ORCA_PANE_KEY = 'tab-1:leaf-1'
    process.env.ORCA_AGENT_HOOK_PORT = '45678'
    process.env.ORCA_AGENT_HOOK_TOKEN = 'test-token'
    globalThis.fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body: unknown = JSON.parse(String(init?.body))
      const payload =
        typeof body === 'object' && body !== null && 'payload' in body ? body.payload : null
      if (typeof payload === 'object' && payload !== null && 'hook_event_name' in payload) {
        events.push(String(payload.hook_event_name))
      }
      return new Response(null, { status: 204 })
    })
  })

  afterEach(() => {
    process.argv = savedArgv
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

  async function sessionStartEvents(argv: string[]): Promise<string[]> {
    events = []
    process.argv = argv
    const pluginPath = join(tempDir, `plugin-${Math.random().toString(36).slice(2)}.mjs`)
    writeFileSync(pluginPath, _internals.getOpenCodePluginSource())
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the generated plugin module exports this factory; the test calls it once.
    const module = (await import(pathToFileURL(pluginPath).href)) as PluginModule
    const hooks = await module.OrcaOpenCodeStatusPlugin?.({})
    await hooks?.event({
      event: { type: 'session.created', properties: { info: { id: 'root' } } }
    })
    return events
  }

  it('posts no session start from an `opencode run` process', async () => {
    await expect(
      sessionStartEvents(['bun', '/$bunfs/root/opencode', 'run', 'fix the bug'])
    ).resolves.toEqual([])
    await expect(
      sessionStartEvents(['/usr/local/bin/opencode', '--log-level', 'INFO', 'run', 'hi'])
    ).resolves.toEqual([])
  })

  it('still posts it from the TUI and from `serve`', async () => {
    await expect(sessionStartEvents(['bun', '/$bunfs/root/opencode'])).resolves.toEqual([
      'SessionStart'
    ])
    await expect(
      sessionStartEvents(['bun', '/$bunfs/root/opencode', 'serve', '--port', '4096'])
    ).resolves.toEqual(['SessionStart'])
  })
})
