import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildPtyHostEnv } from './assembly'
import type { BuildPtyHostEnvOptions } from './types'

const fixture = vi.hoisted(() => ({ userData: '', guestOverlay: '' }))
vi.mock('../../../../shared/app-environment', () => ({
  getAppEnvironment: () => ({ getPath: () => fixture.userData, onWillQuit: vi.fn() })
}))
vi.mock('../../../agent-hooks/server/agent-hook-server', () => ({
  agentHookServer: { buildPtyEnv: () => ({ ORCA_AGENT_HOOK_PORT: '12345' }) }
}))
vi.mock('../../../agent-hooks/wsl-relay/wsl-hook-relay-manager', () => ({
  wslHookRelayManager: {
    ensureForDistro: vi.fn(),
    getGuestEndpointFilePath: () => '/guest/endpoint.json',
    getOpenCodeOverlayDir: () => fixture.guestOverlay,
    getClaudeAgentView: () => null,
    getGuestAgentPath: () => null
  }
}))
vi.mock('../../../pi/titlebar-extension-service', () => ({
  piTitlebarExtensionService: { buildPtyEnv: () => ({}), buildFreshOmpEnv: () => ({}) }
}))
vi.mock('../../../cli/launchers/orca-cli-child-path', () => ({
  prependOrcaCliDirToChildPath: () => {}
}))
vi.mock('../../../cli/wsl/wsl-managed-cli', () => ({
  getManagedWslCliDir: () => undefined,
  getWslCliCommandName: () => 'orca-ide'
}))

let root: string
let custom: string
let options: BuildPtyHostEnvOptions

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-opencode-disabled-'))
  const home = join(root, 'home')
  const xdg = join(root, 'xdg')
  mkdirSync(home)
  fixture.userData = join(root, 'user-data')
  fixture.guestOverlay = join(root, 'guest-overlay')
  custom = join(root, 'custom')
  mkdirSync(join(custom, 'plugins'), { recursive: true })
  writeFileSync(join(custom, 'opencode.json'), '{"model":"fixture"}')
  writeFileSync(join(custom, 'plugins', 'user.js'), '// user plugin')
  vi.stubEnv('HOME', home)
  vi.stubEnv('USERPROFILE', home)
  vi.stubEnv('XDG_CONFIG_HOME', xdg)
  for (const key of [
    'OPENCODE_CONFIG_DIR',
    'ORCA_OPENCODE_CONFIG_DIR',
    'ORCA_OPENCODE_SOURCE_CONFIG_DIR',
    'ORCA_OPENCODE_AGENT',
    'ZDOTDIR'
  ]) {
    vi.stubEnv(key, undefined)
  }
  options = {
    isPackaged: true,
    userDataPath: fixture.userData,
    selectedCodexHomePath: null,
    agentStatusHooksEnabled: true
  }
})
afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})

describe('OpenCode installation uses the current enabled agents', () => {
  it('refuses spawn if a prepared startup intent loses its owned installer', () => {
    mkdirSync(fixture.userData, { recursive: true })
    writeFileSync(
      join(fixture.userData, 'opencode-startup-prompt-overlays'),
      'blocked fixture root'
    )
    expect(() =>
      buildPtyHostEnv(
        'owned-launch',
        {
          OPENCODE_CONFIG_DIR: custom,
          ORCA_OPENCODE_PLUGIN_API: 'v2',
          ORCA_OPENCODE_STARTUP_PROMPT_NONCE: 'fixture-nonce',
          ORCA_OPENCODE_STARTUP_PROMPT_BODY: 'original caller brief'
        },
        { ...options, agentStatusHooksEnabled: false }
      )
    ).toThrow('launch was canceled')
    expect(readFileSync(join(custom, 'opencode.json'), 'utf8')).toBe('{"model":"fixture"}')
    expect(readFileSync(join(custom, 'plugins', 'user.js'), 'utf8')).toBe('// user plugin')
  })
})
