import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildPtyHostEnv } from './assembly'
import { rememberManagedAgentRelease } from '../../../managed-agent-cli/managed-agent-cli-registry'

const fixture = vi.hoisted(() => ({ userData: '' }))
vi.mock('../../../../shared/app-lifecycle/app-environment', () => ({
  getAppEnvironment: () => ({ getPath: () => fixture.userData, onWillQuit: vi.fn() })
}))
vi.mock('../../../agent-hooks/server/agent-hook-server', () => ({
  agentHookServer: { buildPtyEnv: () => ({}) }
}))
vi.mock('../../../agent-hooks/wsl-relay/wsl-hook-relay-manager', () => ({
  wslHookRelayManager: {
    ensureForDistro: vi.fn(),
    getGuestEndpointFilePath: () => '/guest/endpoint.json',
    getOpenCodeOverlayDir: () => null,
    getClaudeAgentView: () => null,
    getGuestAgentPath: () => null
  }
}))
vi.mock('../../../pi/managed-extensions/titlebar-extension-service', () => ({
  piTitlebarExtensionService: { buildPtyEnv: () => ({}), buildFreshOmpEnv: () => ({}) }
}))
vi.mock('../../../cli/launchers/orca-cli-child-path', () => ({
  prependOrcaCliDirToChildPath: () => {}
}))
vi.mock('../../../pty/environment/windows-environment-path', () => ({
  mergePersistedWindowsPath: () => {}
}))
vi.mock('../../../cli/wsl/wsl-managed-cli', () => ({
  getManagedWslCliDir: () => undefined,
  getWslCliCommandName: () => 'orca-ide'
}))
vi.mock('../../../codex/hooks/reconciliation/codex-hook-reconcile', () => ({
  scheduleCodexHookReconcile: () => {}
}))

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-managed-agent-path-'))
  fixture.userData = join(root, 'user-data')
  vi.stubEnv('HOME', join(root, 'home'))
  // Orca's own Claude and Codex are installed on this host.
  rememberManagedAgentRelease('claude', join(root, 'managed', 'claude', 'release-1'))
  rememberManagedAgentRelease('codex', join(root, 'managed', 'codex', 'release-1'))
})
afterEach(() => {
  rememberManagedAgentRelease('claude', null)
  rememberManagedAgentRelease('codex', null)
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})

it.each([
  ['a native terminal', { isWsl: false }],
  ['a WSL terminal', { isWsl: true, wslDistro: 'Ubuntu' }]
])("keeps %s's PATH as inherited with Orca's agent copies installed", (_label, host) => {
  const env = buildPtyHostEnv(
    'pane',
    { PATH: '/usr/local/bin:/usr/bin:/bin' },
    {
      isPackaged: true,
      userDataPath: fixture.userData,
      selectedCodexHomePath: null,
      agentStatusHooksEnabled: false,
      ...host
    }
  )

  expect(env.PATH).toBe('/usr/local/bin:/usr/bin:/bin')
  expect(env.ORCA_MANAGED_AGENT_PATH).toBeUndefined()
})
