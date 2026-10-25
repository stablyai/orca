import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
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
vi.mock('../../../cli/orca-cli-child-path', () => ({ prependOrcaCliDirToChildPath: () => {} }))
vi.mock('../../../cli/wsl-managed-cli', () => ({
  getManagedWslCliDir: () => undefined,
  getWslCliCommandName: () => 'orca-ide'
}))

let root: string
let options: BuildPtyHostEnvOptions

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-draft-bridge-env-'))
  fixture.userData = join(root, 'user-data')
  vi.stubEnv('HOME', join(root, 'home'))
  vi.stubEnv('USERPROFILE', join(root, 'home'))
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

describe('Pi draft bridge environment', () => {
  it('mints a per-PTY bridge directory and token for the agent to answer', () => {
    const env = buildPtyHostEnv('pty-1', { ORCA_PANE_KEY: 'tab-1:leaf-1' }, options)
    expect(env.ORCA_PI_DRAFT_BRIDGE_DIR).toBeTruthy()
    expect(env.ORCA_PI_DRAFT_BRIDGE_TOKEN).toBeTruthy()
    const session = JSON.parse(
      readFileSync(join(env.ORCA_PI_DRAFT_BRIDGE_DIR!, 'session.json'), 'utf8')
    )
    expect(session).toMatchObject({
      protocol: 1,
      token: env.ORCA_PI_DRAFT_BRIDGE_TOKEN,
      paneKey: 'tab-1:leaf-1'
    })
  })

  it('does not point a WSL guest at a host path it cannot read', () => {
    const env = buildPtyHostEnv(
      'pty-1',
      { ORCA_PANE_KEY: 'tab-1:leaf-1' },
      { ...options, isWsl: true, wslDistro: 'Ubuntu' }
    )
    expect(env.ORCA_PI_DRAFT_BRIDGE_DIR).toBeUndefined()
    expect(existsSync(join(fixture.userData, 'pi-draft-bridge'))).toBe(false)
  })

  it('leaves disabled agent hooks without a bridge', () => {
    const env = buildPtyHostEnv(
      'pty-1',
      { ORCA_PANE_KEY: 'tab-1:leaf-1' },
      { ...options, agentStatusHooksEnabled: false }
    )
    expect(env.ORCA_PI_DRAFT_BRIDGE_DIR).toBeUndefined()
  })
})
