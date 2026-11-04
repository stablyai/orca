import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  applyDesktopCuaReplBrowserSurfaceOverride,
  DESKTOP_CUA_REPL_BROWSER_OFF_MARKER,
  stripDesktopCuaReplBrowserSurfaceOverride
} from './config-toml-desktop-cua-repl-browser-surface'
import { extractOrdinaryCodexSettings } from './config-toml-runtime-owned-sections'

const PLUGIN_VERSION = '26.1027.51404'

let root: string
let systemHome: string
let runtimeHome: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-cua-repl-'))
  systemHome = join(root, 'system')
  runtimeHome = join(root, 'runtime')
  mkdirSync(systemHome, { recursive: true })
  mkdirSync(runtimeHome, { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function writeSystemConfig(config: string): void {
  writeFileSync(join(systemHome, 'config.toml'), config, 'utf-8')
}

function writeDesktopPluginMcp(env: Record<string, string>, version = PLUGIN_VERSION): void {
  const pluginDirectory = join(
    systemHome,
    'plugins',
    'cache',
    'openai-bundled',
    'unified-computer-use',
    version
  )
  mkdirSync(pluginDirectory, { recursive: true })
  writeFileSync(
    join(pluginDirectory, '.mcp.json'),
    JSON.stringify({
      mcpServers: {
        cua_repl: {
          command: 'C:\\Codex\\node.exe',
          args: [
            '--import',
            'file:///C:/Codex/require-browser-access.mjs',
            'file:///C:/Codex/cua-repl.mjs'
          ],
          enabled: true,
          enabled_tools: ['js', 'js_reset', 'turn_ended'],
          startup_timeout_sec: 120,
          tools: { js: { output_token_limit: 25000 } },
          env
        }
      }
    }),
    'utf-8'
  )
}

const ENABLING_CONFIG = `[plugins."computer-use@openai-bundled"]
enabled = true

[mcp_servers.node_repl]
command = 'C:\\Codex\\node_repl.exe'
`

const DESKTOP_ENV = {
  CUA_REPL_ENABLED_SURFACES: 'browser,computer',
  CODEX_HOME: 'C:\\Users\\me\\.codex'
}

function apply(config: string): string {
  return applyDesktopCuaReplBrowserSurfaceOverride(config, {
    systemHomePath: systemHome,
    runtimeHomePath: runtimeHome
  })
}

describe('desktop cua_repl browser surface override', () => {
  it('copies the desktop server with the browser surface removed', () => {
    writeSystemConfig(ENABLING_CONFIG)
    writeDesktopPluginMcp(DESKTOP_ENV)

    expect(apply('model = "gpt-5"\n')).toBe(`model = "gpt-5"

[mcp_servers.cua_repl] ${DESKTOP_CUA_REPL_BROWSER_OFF_MARKER}
command = 'C:\\Codex\\node.exe'
args = ['--import', 'file:///C:/Codex/require-browser-access.mjs', 'file:///C:/Codex/cua-repl.mjs']
enabled = true
enabled_tools = ['js', 'js_reset', 'turn_ended']
startup_timeout_sec = 120
[mcp_servers.cua_repl.tools.js]
output_token_limit = 25000
[mcp_servers.cua_repl.env]
CUA_REPL_ENABLED_SURFACES = 'computer'
CODEX_HOME = 'C:\\Users\\me\\.codex'
`)
  })

  it('replaces its own previous override instead of stacking tables', () => {
    writeSystemConfig(ENABLING_CONFIG)
    writeDesktopPluginMcp(DESKTOP_ENV)
    const once = apply('model = "gpt-5"\n')

    expect(apply(once)).toBe(once)
    expect(stripDesktopCuaReplBrowserSurfaceOverride(once)).toBe('model = "gpt-5"\n')
  })

  it('leaves a user-declared cua_repl server alone', () => {
    writeSystemConfig(
      `${ENABLING_CONFIG}
[mcp_servers.cua_repl]
command = 'my-cua-repl'
`
    )
    writeDesktopPluginMcp(DESKTOP_ENV)

    expect(apply('model = "gpt-5"\n')).toBe('model = "gpt-5"\n')
  })

  it('drops a stale override once the desktop plugin stops shipping the browser surface', () => {
    writeSystemConfig(ENABLING_CONFIG)
    writeDesktopPluginMcp(DESKTOP_ENV)
    const withOverride = apply('')
    writeDesktopPluginMcp({ ...DESKTOP_ENV, CUA_REPL_ENABLED_SURFACES: 'computer' })

    expect(apply(withOverride)).toBe('')
  })

  it('keeps the override out of the canonical config seed', () => {
    writeSystemConfig(ENABLING_CONFIG)
    writeDesktopPluginMcp(DESKTOP_ENV)

    expect(extractOrdinaryCodexSettings(apply('model = "gpt-5"\n'))).toBe('model = "gpt-5"')
  })
})
