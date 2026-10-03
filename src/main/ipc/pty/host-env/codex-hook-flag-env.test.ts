import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildPtyHostEnv } from './assembly'
import type { BuildPtyHostEnvOptions } from './types'

const fixture = vi.hoisted(() => ({ userData: '' }))
vi.mock('../../../../shared/app-environment', () => ({
  getAppEnvironment: () => ({ getPath: () => fixture.userData, onWillQuit: vi.fn() })
}))
vi.mock('../../../agent-hooks/server', () => ({
  agentHookServer: { buildPtyEnv: () => ({ ORCA_AGENT_HOOK_PORT: '12345' }) }
}))
vi.mock('../../../agent-hooks/wsl-hook-relay-manager', () => ({
  wslHookRelayManager: {
    ensureForDistro: vi.fn(),
    getGuestEndpointFilePath: () => '/guest/endpoint.json',
    getOpenCodeOverlayDir: () => null,
    getGuestAgentPath: () => null
  }
}))
vi.mock('../../../pi/titlebar-extension-service', () => ({
  piTitlebarExtensionService: { buildPtyEnv: () => ({}), buildFreshOmpEnv: () => ({}) }
}))
const { scheduleCodexHookFlagSync } = vi.hoisted(() => ({ scheduleCodexHookFlagSync: vi.fn() }))
vi.mock('../../../codex/codex-hook-flag-sync', () => ({ scheduleCodexHookFlagSync }))
vi.mock('../../../cli/orca-cli-child-path', () => ({ prependOrcaCliDirToChildPath: () => {} }))
vi.mock('../../../cli/wsl-managed-cli', () => ({
  getManagedWslCliDir: () => undefined,
  getWslCliCommandName: () => 'orca-ide'
}))

let root: string
let options: BuildPtyHostEnvOptions
// Why: a pane opened inside another Orca's pane inherits that Orca's value.
const INHERITED = { ORCA_CODEX_HOOK_FLAGS: '/other-orca/codex-hook-flags' }

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-codex-hook-flag-env-'))
  fixture.userData = join(root, 'user-data')
  vi.stubEnv('HOME', join(root, 'home'))
  vi.stubEnv('ORCA_USER_DATA_PATH', fixture.userData)
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

describe('Codex status hook flag table in the pane env', () => {
  // Why whatever the settings: the table is absent while hooks are off, and a pane
  // opened then must still find the flag once they turn back on.
  it.each([
    ['hooks are on', {}],
    ['hooks are off', { agentStatusHooksEnabled: false }],
    ['Codex is disabled', { disabledTuiAgents: ['codex' as const] }]
  ])("points a native pane at this profile's flag table when %s", (_label, overrides) => {
    const env = buildPtyHostEnv('pane-1', { ...INHERITED }, { ...options, ...overrides })
    expect(env.ORCA_CODEX_HOOK_FLAGS).toBe(join(fixture.userData, 'codex-hook-flags'))
  })

  it('clears an inherited flag table in a WSL guest, whose Linux Codex keeps its installed hook', () => {
    const env = buildPtyHostEnv('pane-1', { ...INHERITED }, { ...options, isWsl: true })
    expect(env.ORCA_CODEX_HOOK_FLAGS).toBeUndefined()
  })

  // Why: a request the file watch missed, or a codex updated meanwhile, is served on the next spawn.
  it('schedules a flag sync for each native pane, but not for a WSL guest', () => {
    scheduleCodexHookFlagSync.mockClear()
    buildPtyHostEnv('pane-1', {}, options)
    expect(scheduleCodexHookFlagSync).toHaveBeenCalledOnce()

    buildPtyHostEnv('pane-2', {}, { ...options, isWsl: true })
    expect(scheduleCodexHookFlagSync).toHaveBeenCalledOnce()
  })
})
