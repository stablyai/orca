import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { CLAUDE_PROFILE_ROUTING_CAPABILITY } from '../../shared/claude-profile-routing'
import { getDefaultSettings } from '../../shared/constants'
import type { ClaudeProfileRoutingOwner } from './claude-profile-routing-owner'

const root = mkdtempSync(join(tmpdir(), 'claude-wsl-default-'))
const ubuntuHome =
  '\\\\wsl.localhost\\Ubuntu\\home\\u\\.local\\share\\orca\\claude-profiles\\u1\\home'
vi.mock('../../shared/app-environment', () => ({
  getAppEnvironment: () => ({ getPath: () => root, isPackaged: () => false, getVersion: () => '0' })
}))
vi.mock('../wsl', () => ({
  getDefaultWslDistro: () => 'Ubuntu',
  getWslHome: () => null
}))
vi.mock('../claude/claude-hook-event-versions', () => ({
  probeClaudeCliVersionCached: async () => null
}))
vi.mock('./claude-profile-wsl-owner', async (importOriginal) => {
  const ubuntu = { runtime: 'wsl' as const, wslDistro: 'Ubuntu' }
  const owner: ClaudeProfileRoutingOwner = {
    resolve: (target) => {
      if (target?.wslDistro !== 'Ubuntu') {
        throw new Error('Claude profile requires a specific WSL distro')
      }
      return {
        profile: {
          version: 1,
          accountId: 'u1',
          target: { executionHostId: 'local', runtime: 'wsl', distro: 'Ubuntu' },
          home: '/home/u/.local/share/orca/claude-profiles/u1/home'
        },
        configHome: '/home/u/.local/share/orca/claude-profiles/u1/home',
        readHome: ubuntuHome,
        defaultHome: '/home/u/.claude',
        pointerPath: '~/.local/share/orca/claude-profiles/selected-wsl',
        target: ubuntu
      }
    },
    refresh: async () => {},
    pointerPath: () => '~/.local/share/orca/claude-profiles/selected-wsl',
    targets: () => [ubuntu],
    readHomes: () => [],
    capabilities: () => [CLAUDE_PROFILE_ROUTING_CAPABILITY],
    isProvisioned: () => true,
    profileState: () => ({ readiness: 'ready', identity: null }),
    prepare: async () => ({ outcome: 'prepared', surfaces: {}, warnings: [] }),
    publish: async () => {},
    withdraw: () => {}
  }
  return {
    ...(await importOriginal<Record<string, unknown>>()),
    createWslClaudeProfileOwner: () => owner
  }
})

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
beforeAll(() => Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' }))
afterAll(() => {
  if (originalPlatform) {
    Object.defineProperty(process, 'platform', originalPlatform)
  }
  rmSync(root, { recursive: true, force: true })
})

it("resolves a WSL target with no distro to the default distro's selected account", async () => {
  const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
  const settings = {
    claudeManagedAccounts: [
      {
        id: 'u1',
        email: 'u1@example.test',
        managedAuthPath: '',
        managedAuthRuntime: 'wsl' as const,
        wslDistro: 'Ubuntu',
        authMethod: 'subscription-oauth' as const,
        createdAt: 1,
        updatedAt: 1,
        lastAuthenticatedAt: 1
      }
    ],
    activeClaudeManagedAccountId: null,
    activeClaudeManagedAccountIdsByRuntime: { host: null, wsl: { Ubuntu: 'u1' } },
    localAccountRuntime: 'wsl' as const,
    localAccountWslDistro: null,
    agentStatusHooksEnabled: false,
    disabledTuiAgents: []
  }
  const service = new ClaudeRuntimeAuthService({
    getSettings: () => ({ ...getDefaultSettings('/tmp'), ...settings })
  })
  const usage = await service.prepareForRateLimitFetch({ runtime: 'wsl', wslDistro: null })
  expect(usage.profileIssue).toBeUndefined()
  expect(usage.configDir).toBe(ubuntuHome)
  const launch = await service.prepareForClaudeLaunch()
  expect(launch.wslDistro).toBe('Ubuntu')
})
