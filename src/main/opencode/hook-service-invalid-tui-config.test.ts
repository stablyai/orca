import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { setAppEnvironment } from '../../shared/app-environment'
import { writeOpenCodeTuiPlugin } from '../../shared/opencode-tui-plugin-install'
import { getOpenCodePluginSource, OpenCodeHookService } from './hook-service'

let root: string
let configDir: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-invalid-tui-config-'))
  configDir = join(root, 'xdg', 'opencode')
  mkdirSync(configDir, { recursive: true })
  vi.stubEnv('XDG_CONFIG_HOME', join(root, 'xdg'))
  vi.stubEnv('ORCA_OPENCODE_PLUGIN_API', 'v2')
  setAppEnvironment({
    getPath: () => join(root, 'profile'),
    getAppPath: () => process.cwd(),
    getVersion: () => '0.0.0-test',
    isPackaged: () => false,
    onWillQuit: () => {},
    exit: () => {},
    getAppMetrics: () => []
  })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})

it.each([
  ['tui.json', '{broken'],
  ['tui.jsonc', '// keep user bytes\n{broken'],
  ['tui.json', '{"plugin":"user-package"}']
])(
  'installs the server plugin while preserving invalid %s and reporting registration failure',
  (name, text) => {
    const configPath = join(configDir, name)
    writeFileSync(configPath, text)
    new OpenCodeHookService().buildPtyEnv('pane-one')
    expect(readFileSync(join(configDir, 'plugins', 'orca-opencode-status.js'), 'utf8')).toBe(
      getOpenCodePluginSource()
    )
    expect(readFileSync(configPath, 'utf8')).toBe(text)
    expect(console.warn).toHaveBeenCalledWith(
      '[OpenCode] Failed to register TUI status plugin:',
      expect.stringContaining('orca-opencode-status-tui'),
      expect.objectContaining({ message: expect.stringContaining('Cannot register') })
    )
  }
)

it('refreshes the retired server plugin even when its TUI config is invalid', () => {
  const shared = join(root, 'profile', 'opencode-hooks', 'shared')
  const serverPath = join(shared, 'plugins', 'orca-opencode-status.js')
  mkdirSync(join(shared, 'plugins'), { recursive: true })
  writeFileSync(serverPath, 'stale server')
  const configPath = join(shared, 'tui.jsonc')
  writeFileSync(configPath, '{broken')
  new OpenCodeHookService().refreshLegacySharedPlugin()
  expect(readFileSync(serverPath, 'utf8')).toBe(getOpenCodePluginSource())
  expect(readFileSync(configPath, 'utf8')).toBe('{broken')
  expect(console.warn).toHaveBeenCalledWith(
    '[OpenCode] Failed to register TUI status plugin:',
    expect.any(String),
    expect.any(Error)
  )
})

it('installs into a source overlay without replacing the invalid user config', () => {
  const source = join(root, 'source')
  mkdirSync(source)
  const text = '// keep\n{broken'
  writeFileSync(join(source, 'tui.jsonc'), text)
  const overlay = new OpenCodeHookService().buildPtyEnv('pane-one', source).OPENCODE_CONFIG_DIR
  expect(overlay).not.toBe(source)
  if (!overlay) {
    throw new Error('No overlay')
  }
  expect(readFileSync(join(overlay, 'plugins', 'orca-opencode-status.js'), 'utf8')).toBe(
    getOpenCodePluginSource()
  )
  expect(readFileSync(join(source, 'tui.jsonc'), 'utf8')).toBe(text)
  expect(readFileSync(join(overlay, 'tui.jsonc'), 'utf8')).toBe(text)
  expect(console.warn).toHaveBeenCalled()
})

it('continues to throw file-system registration errors for the existing write retry contract', () => {
  const plugins = join(configDir, 'plugins')
  mkdirSync(join(configDir, 'tui.json'))
  expect(() =>
    writeOpenCodeTuiPlugin(plugins, 'orca-opencode-status.js', getOpenCodePluginSource())
  ).toThrow()
  expect(console.warn).not.toHaveBeenCalled()
})
