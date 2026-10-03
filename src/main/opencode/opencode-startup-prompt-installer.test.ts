import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setAppEnvironment } from '../../shared/app-environment'
import {
  createOpenCodeStartupPromptInstaller,
  installOpenCodeStartupPromptForLaunch
} from './opencode-startup-prompt-installer'

let root: string
let originalXdg: string | undefined
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'opencode-prompt-install-'))
  originalXdg = process.env.XDG_CONFIG_HOME
  process.env.XDG_CONFIG_HOME = join(root, 'config')
  setAppEnvironment({
    getPath: () => join(root, 'profile'),
    getAppPath: () => root,
    getVersion: () => 'test',
    isPackaged: () => false,
    onWillQuit: () => {},
    exit: () => {},
    getAppMetrics: () => []
  })
})
afterEach(() => {
  vi.unstubAllEnvs()
  if (originalXdg === undefined) {
    delete process.env.XDG_CONFIG_HOME
  } else {
    process.env.XDG_CONFIG_HOME = originalXdg
  }
  rmSync(root, { recursive: true, force: true })
})
describe('OpenCode startup prompt installer', () => {
  it.each(['inherited', 'explicit'] as const)(
    'preserves status and user plugins from the %s XDG config when launch env is sparse',
    (selection) => {
      const configHome = join(root, selection === 'explicit' ? 'selected-config' : 'config')
      const config = join(configHome, 'opencode')
      mkdirSync(join(config, 'plugins'), { recursive: true })
      writeFileSync(join(config, 'plugins', 'orca-opencode-status.js'), 'status entry')
      writeFileSync(join(config, 'plugins', 'user.js'), 'user entry')
      writeFileSync(join(config, 'opencode.json'), '{"model":"selected/model"}')
      const env: Record<string, string> = {
        ORCA_OPENCODE_PLUGIN_API: 'v2',
        ORCA_OPENCODE_STARTUP_PROMPT_NONCE: 'sparse-launch',
        ...(selection === 'explicit' ? { XDG_CONFIG_HOME: configHome } : {})
      }
      expect(installOpenCodeStartupPromptForLaunch(env)).toBe(true)
      expect(
        readFileSync(join(env.OPENCODE_CONFIG_DIR, 'plugins', 'orca-opencode-status.js'), 'utf8')
      ).toBe('status entry')
      expect(readFileSync(join(env.OPENCODE_CONFIG_DIR, 'plugins', 'user.js'), 'utf8')).toBe(
        'user entry'
      )
      expect(readFileSync(join(env.OPENCODE_CONFIG_DIR, 'opencode.json'), 'utf8')).toContain(
        'selected/model'
      )
    }
  )

  it("uses the execution owner's resolved environment instead of reintroducing a deleted ambient XDG home", () => {
    const selected = join(root, 'resolved-config')
    mkdirSync(join(selected, 'opencode', 'plugins'), { recursive: true })
    writeFileSync(join(selected, 'opencode', 'plugins', 'user.js'), 'resolved entry')
    const env: Record<string, string> = {
      ORCA_OPENCODE_PLUGIN_API: 'v2',
      ORCA_OPENCODE_STARTUP_PROMPT_NONCE: 'resolved-launch'
    }
    expect(installOpenCodeStartupPromptForLaunch(env, false, { XDG_CONFIG_HOME: selected })).toBe(
      true
    )
    expect(readFileSync(join(env.OPENCODE_CONFIG_DIR, 'plugins', 'user.js'), 'utf8')).toBe(
      'resolved entry'
    )
    expect(env.ORCA_OPENCODE_CONFIG_DIR).toBeUndefined()
  })

  it.each(['inherited', 'explicit'] as const)(
    'preserves the %s OPENCODE_CONFIG_DIR ahead of the XDG default',
    (selection) => {
      const ambient = join(root, 'ambient-source')
      const selected = join(root, 'selected-source')
      for (const config of [ambient, selected]) {
        mkdirSync(join(config, 'plugins'), { recursive: true })
        writeFileSync(join(config, 'plugins', 'user.js'), config)
      }
      vi.stubEnv('OPENCODE_CONFIG_DIR', ambient)
      const env: Record<string, string> = {
        ORCA_OPENCODE_PLUGIN_API: 'v2',
        ORCA_OPENCODE_STARTUP_PROMPT_NONCE: 'custom-config-launch',
        ...(selection === 'explicit' ? { OPENCODE_CONFIG_DIR: selected } : {})
      }
      expect(installOpenCodeStartupPromptForLaunch(env)).toBe(true)
      expect(readFileSync(join(env.OPENCODE_CONFIG_DIR, 'plugins', 'user.js'), 'utf8')).toBe(
        selection === 'explicit' ? selected : ambient
      )
    }
  )

  it('keeps a missing user config untouched and installs the launch into an owned overlay', () => {
    const source = join(root, 'missing-user-config')
    const env: Record<string, string> = {
      ORCA_OPENCODE_PLUGIN_API: 'v2',
      ORCA_OPENCODE_STARTUP_PROMPT_NONCE: 'private-launch',
      OPENCODE_CONFIG_DIR: source,
      OPENCODE_CONFIG_CONTENT: '{"model":"opencode/model"}'
    }
    installOpenCodeStartupPromptForLaunch(env)
    expect(existsSync(source)).toBe(false)
    expect(env.OPENCODE_CONFIG_DIR).toContain(
      join(root, 'profile', 'opencode-startup-prompt-overlays')
    )
    expect(env.ORCA_OPENCODE_CONFIG_DIR).toBe(env.OPENCODE_CONFIG_DIR)
    expect(env.OPENCODE_CONFIG_CONTENT).toBe('{"model":"opencode/model"}')
    expect(
      existsSync(join(env.OPENCODE_CONFIG_DIR, 'plugins', 'orca-opencode-startup-prompt', 'tui.js'))
    ).toBe(true)
    expect(existsSync(join(env.OPENCODE_CONFIG_DIR, 'plugins', 'orca-opencode-status.js'))).toBe(
      false
    )
  })
  it('installs only a TUI entry without installing status hooks or a v1/server entry', () => {
    const service = createOpenCodeStartupPromptInstaller(() => 'prompt source')
    expect(service.buildPtyEnv('pane')).toEqual({})
    const plugins = join(root, 'config', 'opencode', 'plugins')
    expect(readFileSync(join(plugins, 'orca-opencode-startup-prompt', 'tui.js'), 'utf8')).toBe(
      'prompt source'
    )
    expect(existsSync(join(plugins, 'orca-opencode-startup-prompt.js'))).toBe(false)
    expect(existsSync(join(plugins, 'orca-opencode-status.js'))).toBe(false)
    expect(existsSync(join(root, 'profile', 'opencode-startup-prompt-hooks'))).toBe(false)
  })
  it('preserves user config and plugins across source-scoped overlay refreshes', () => {
    const config = join(root, 'custom')
    mkdirSync(join(config, 'plugins'), { recursive: true })
    writeFileSync(join(config, 'opencode.json'), '{"model":"user/model"}')
    writeFileSync(join(config, 'plugins', 'user.js'), 'user source')
    mkdirSync(join(config, 'plugins', 'orca-opencode-startup-prompt'))
    writeFileSync(
      join(config, 'plugins', 'orca-opencode-startup-prompt', 'tui.js'),
      'user collision'
    )
    let source = 'first prompt source'
    const service = createOpenCodeStartupPromptInstaller(() => source)
    const first = service.buildPtyEnv('pane-a', config).OPENCODE_CONFIG_DIR
    expect(first).toBeDefined()
    source = 'next prompt source'
    expect(service.buildPtyEnv('pane-b', config).OPENCODE_CONFIG_DIR).toBe(first)
    if (!first) {
      throw new Error('Missing overlay')
    }
    expect(
      readFileSync(join(first, 'plugins', 'orca-opencode-startup-prompt', 'tui.js'), 'utf8')
    ).toBe(source)
    expect(readFileSync(join(first, 'opencode.json'), 'utf8')).toContain('user/model')
    expect(readFileSync(join(first, 'plugins', 'user.js'), 'utf8')).toBe('user source')
    expect(
      readFileSync(join(config, 'plugins', 'orca-opencode-startup-prompt', 'tui.js'), 'utf8')
    ).toBe('user collision')
  })
})
