import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BuildPtyHostEnvOptions } from './types'

const fixture = vi.hoisted(() => ({ userData: '', scheduleCodexHookReconcile: vi.fn() }))
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
    getOpenCodeOverlayDir: () => join(fixture.userData, 'guest-overlay'),
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
vi.mock('../../../codex/codex-hook-reconcile', () => ({
  scheduleCodexHookReconcile: fixture.scheduleCodexHookReconcile
}))

import { buildPtyHostEnv } from './assembly'

// Why this file: a codex typed in a native pane reads ~/.codex, so each native
// spawn rechecks Orca's entry there; a WSL pane's Codex never reads it.

let root: string
let options: BuildPtyHostEnvOptions

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-codex-reconcile-spawn-'))
  fixture.userData = join(root, 'user-data')
  vi.stubEnv('HOME', join(root, 'home'))
  vi.stubEnv('USERPROFILE', join(root, 'home'))
  options = {
    isPackaged: true,
    userDataPath: fixture.userData,
    selectedCodexHomePath: null,
    agentStatusHooksEnabled: true
  }
  fixture.scheduleCodexHookReconcile.mockClear()
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})

describe("a pane spawn rechecks Orca's entry in ~/.codex", () => {
  it('on a native spawn', () => {
    buildPtyHostEnv('native-pane', {}, options)

    expect(fixture.scheduleCodexHookReconcile).toHaveBeenCalledTimes(1)
  })

  it('never on a WSL spawn', () => {
    buildPtyHostEnv('wsl-pane', {}, { ...options, isWsl: true, wslDistro: 'Ubuntu' })

    expect(fixture.scheduleCodexHookReconcile).not.toHaveBeenCalled()
  })
})
