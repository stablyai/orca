import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { setAppEnvironment } from '../../shared/app-environment'
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
