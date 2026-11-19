import { afterEach, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RateLimitService } from './rate-limit-service'
import { ClaudeProfileRouter } from '../../claude-accounts/profiles/routing/claude-profile-router'
import { installClaudeProfileRouter } from '../../claude-accounts/profiles/routing/claude-profile-installed-router'

const roots: string[] = []
afterEach(() => {
  installClaudeProfileRouter(undefined)
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

it('records live workspace usage with OAuth polling disabled and leaves host default quota unchanged', () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-workspace-live-'))
  roots.push(root)
  mkdirSync(join(root, 'user'), { recursive: true })
  const router = new ClaudeProfileRouter({
    dataRoot: join(root, 'data'),
    userHome: join(root, 'user'),
    env: {},
    getSettings: () => ({
      activeClaudeManagedAccountId: null,
      claudeManagedAccounts: [],
      agentStatusHooksEnabled: false,
      disabledTuiAgents: []
    })
  })
  installClaudeProfileRouter(router)
  const service = new RateLimitService()
  service.setClaudeOAuthUsageEnabledResolver(() => false)
  service.setInactiveClaudeAccountsResolver(() => [{ id: 'work', managedAuthRuntime: 'host' }])
  service.ingestLiveClaudeRateLimits({
    configDir: join(root, 'data', 'claude-profiles', 'work', 'home'),
    fiveHour: { used_percentage: 27 },
    sevenDay: { used_percentage: 42 }
  })
  service.ingestLiveClaudeRateLimits({
    configDir: join(root, 'data', 'claude-profiles', 'work', 'home'),
    fiveHour: { used_percentage: 28 },
    sevenDay: null
  })
  service.discardClaudeOAuthUsage()
  const state = service.getState()
  expect(state.claude?.session).toBeNull()
  expect(state.inactiveClaudeAccounts[0]?.rateLimits?.session?.usedPercent).toBe(28)
  expect(state.inactiveClaudeAccounts[0]?.rateLimits?.weekly?.usedPercent).toBe(42)
  expect(state.inactiveClaudeAccounts[0]?.rateLimits?.usageMetadata?.readingAccount).toEqual({
    accountId: 'work',
    runtime: 'host',
    wslDistro: null
  })
  service.ingestLiveClaudeRateLimits({
    configDir: join(root, 'unknown'),
    fiveHour: { used_percentage: 99 },
    sevenDay: null
  })
  expect(service.getState().inactiveClaudeAccounts[0]?.rateLimits?.session?.usedPercent).toBe(28)
  expect(service.getState().claude?.session).toBeNull()
})

it('attributes the first live reading when the bound account is also the host default', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-workspace-active-'))
  roots.push(root)
  mkdirSync(join(root, 'user'), { recursive: true })
  const home = join(root, 'data', 'claude-profiles', 'work', 'home')
  installClaudeProfileRouter(
    new ClaudeProfileRouter({
      dataRoot: join(root, 'data'),
      userHome: join(root, 'user'),
      env: {},
      getSettings: () => ({
        activeClaudeManagedAccountId: null,
        claudeManagedAccounts: [],
        agentStatusHooksEnabled: false,
        disabledTuiAgents: []
      })
    })
  )
  const service = new RateLimitService()
  service.setClaudeOAuthUsageEnabledResolver(() => false)
  service.setInactiveClaudeAccountsResolver(() => [{ id: 'work', managedAuthRuntime: 'host' }])
  service.setClaudeAuthPreparationResolver(async () => ({
    configDir: home,
    envPatch: { CLAUDE_CONFIG_DIR: home },
    provenance: 'profile:work',
    readingAccount: { accountId: 'work', runtime: 'host', wslDistro: null }
  }))
  await service.refreshClaudeForTarget({ runtime: 'host' })
  service.ingestLiveClaudeRateLimits({
    configDir: home,
    fiveHour: { used_percentage: 13 },
    sevenDay: null
  })
  expect(service.getState().claude?.session?.usedPercent).toBe(13)
  expect(service.getState().claude?.usageMetadata?.readingAccount?.accountId).toBe('work')
})

it('records system-default workspace usage from live posts without replacing the managed host quota', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-default-live-'))
  roots.push(root)
  mkdirSync(join(root, 'user'), { recursive: true })
  const router = new ClaudeProfileRouter({
    dataRoot: join(root, 'data'),
    userHome: join(root, 'user'),
    env: {},
    getSettings: () => ({
      activeClaudeManagedAccountId: null,
      claudeManagedAccounts: [],
      agentStatusHooksEnabled: false,
      disabledTuiAgents: []
    })
  })
  installClaudeProfileRouter(router)
  const service = new RateLimitService()
  service.setClaudeOAuthUsageEnabledResolver(() => false)
  service.setInactiveClaudeAccountsResolver(() => [
    { id: 'system-default:host:["personal@example.com","personal-org"]' }
  ])
  service.setClaudeAuthPreparationResolver(async () => ({
    configDir: router.accountHome('work'),
    envPatch: { CLAUDE_CONFIG_DIR: router.accountHome('work') },
    provenance: 'profile:work',
    readingAccount: { accountId: 'work', runtime: 'host', wslDistro: null }
  }))
  await service.refreshClaudeForTarget({ runtime: 'host' })
  service.ingestLiveClaudeRateLimits({
    configDir: router.accountHome('work'),
    fiveHour: { used_percentage: 91 },
    sevenDay: null
  })
  service.ingestLiveClaudeRateLimits({
    configDir: router.systemDefaultHome(),
    accountId: 'system-default:host:["personal@example.com","personal-org"]',
    fiveHour: { used_percentage: 38 },
    sevenDay: null
  })
  const state = service.getState()
  expect(state.claude?.session?.usedPercent).toBe(91)
  expect(state.inactiveClaudeAccounts[0]?.rateLimits?.session?.usedPercent).toBe(38)
  expect(state.inactiveClaudeAccounts[0]?.rateLimits?.usageMetadata?.authProvenance).toBe('system')
})
