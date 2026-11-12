import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setAppEnvironment } from '../../../shared/app-environment'
import {
  createOpenCodeStartupPromptInstaller,
  installOpenCodeStartupPromptForLaunch
} from './opencode-startup-prompt-installer'
import {
  captureOpenCodeSourceConfig,
  applyOpenCodeStatusPluginEnv
} from '../../ipc/pty/host-env/opencode-config'

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
  it('refuses a replaced status overlay instead of writing through its symlink or losing status hooks', () => {
    const source = join(root, 'safe-source')
    const foreign = join(root, 'foreign')
    mkdirSync(source)
    mkdirSync(foreign)
    writeFileSync(join(foreign, 'untouched.txt'), 'foreign bytes')
    const env: Record<string, string> = {
      OPENCODE_CONFIG_DIR: source,
      ORCA_OPENCODE_PLUGIN_API: 'v2',
      ORCA_OPENCODE_STARTUP_PROMPT_NONCE: 'replaced-overlay'
    }
    const config = captureOpenCodeSourceConfig(env, join(root, 'profile'))
    applyOpenCodeStatusPluginEnv(
      'pane',
      env,
      config,
      {
        launchAgent: 'opencode',
        agentStatusHooksEnabled: true
      },
      'opencode'
    )
    rmSync(env.OPENCODE_CONFIG_DIR, { recursive: true })
    symlinkSync(foreign, env.OPENCODE_CONFIG_DIR, 'junction')
    expect(installOpenCodeStartupPromptForLaunch(env)).toBe(false)
    expect(env.ORCA_OPENCODE_STARTUP_PROMPT_NONCE).toBeUndefined()
    expect(readFileSync(join(foreign, 'untouched.txt'), 'utf8')).toBe('foreign bytes')
    expect(existsSync(join(foreign, 'plugins'))).toBe(false)
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
