import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import type { ResolvedSourceControlAiGenerationParams } from '../../shared/source-control-ai'
import { createGlobalSettingsFixture } from '../../shared/global-settings-test-fixture'
import { ClaudeProfileRouter } from '../claude-accounts/claude-profile-router'
import { provisionClaudeAccountProfile } from '../claude-accounts/claude-profile-setup'
import { fetchActiveClaudeRateLimits } from '../rate-limits/claude-active-usage-fetch'
import { setMainHttpClient } from '../network/http-client'
import { createClaudeTextSubscriptionPreparation } from './claude-text-subscriptions'
import { beginTextGenerationRequest } from './source-control-generation-lanes'
import { runGenerationRequest } from './agent-generation-request'
import { spawnSourceControlAgent } from './source-control-agent-launch'
import { ClaudeRuntimeAuthService } from '../claude-accounts/runtime-auth-service'
import { RateLimitService } from '../rate-limits/service'

const roots: string[] = []
export function cleanupClaudeTextSubscriptions() {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
}

export async function claudeTextSubscriptionFixture(
  options: {
    enabled?: boolean
    behavior?: Record<string, string>
    overflowDisabled?: boolean
    version?: string
  } = {}
) {
  const root = mkdtempSync(join(tmpdir(), 'orca-subscriptions-'))
  roots.push(root)
  const home = (id: string) => join(root, 'data', 'claude-profiles', id, 'home')
  const userHome = join(root, 'user')
  mkdirSync(join(userHome, '.claude'), { recursive: true })
  const accounts = ['a', 'b', 'c', 'd'].map((id) => ({
    id,
    email: `${id}@example.test`,
    organizationUuid: `org-${id}`,
    managedAuthPath: '/unused',
    authMethod: 'subscription-oauth' as const,
    createdAt: 0,
    updatedAt: 0,
    lastAuthenticatedAt: 0
  }))
  const settings = createGlobalSettingsFixture({
    claudeManagedAccounts: accounts,
    activeClaudeManagedAccountId: 'a',
    autoRenameBranchFromWork: true,
    defaultTuiAgent: 'claude',
    branchPrefix: 'none',
    textGenerationSubscriptionFailoverEnabled: options.enabled !== false,
    agentStatusHooksEnabled: false,
    disabledTuiAgents: []
  })
  const router = new ClaudeProfileRouter({
    dataRoot: join(root, 'data'),
    userHome,
    env: {},
    getSettings: () => settings,
    runSetup: (args) => provisionClaudeAccountProfile({ ...args, installHooks: null })
  })
  for (const account of accounts) {
    mkdirSync(home(account.id), { recursive: true })
    writeFileSync(
      join(home(account.id), '.claude.json'),
      JSON.stringify({
        oauthAccount: { emailAddress: account.email, organizationUuid: account.organizationUuid }
      })
    )
    writeFileSync(
      join(home(account.id), '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: account.id } })
    )
  }
  const limits = new Map<string, Awaited<ReturnType<typeof fetchActiveClaudeRateLimits>>>()
  setMainHttpClient({
    proxySession: () => null,
    fetch: async (_url, input) => {
      const id = new Headers(input?.headers).get('Authorization')?.replace('Bearer ', '')
      return new Response(
        JSON.stringify({
          five_hour: {
            utilization: id === 'a' ? 100 : 10,
            resets_at: new Date(Date.now() + 3600000).toISOString()
          },
          seven_day: { utilization: 20, resets_at: new Date(Date.now() + 86400000).toISOString() },
          extra_usage: { is_enabled: options.overflowDisabled === false }
        })
      )
    }
  })
  for (const account of accounts) {
    limits.set(
      account.id,
      await fetchActiveClaudeRateLimits({
        authPreparation: {
          configDir: home(account.id),
          envPatch: { CLAUDE_CONFIG_DIR: home(account.id) },
          provenance: `profile:${account.id}`
        }
      })
    )
  }
  const state = new RateLimitService().getState()
  const rateLimits = {
    refreshTextSubscriptionAccounts: async () => {},
    getState: () => ({
      ...state,
      claude: limits.get('a') ?? null,
      inactiveClaudeAccounts: accounts.slice(1).map((a) => ({
        accountId: a.id,
        rateLimits: limits.get(a.id)!,
        updatedAt: Date.now(),
        isFetching: false
      }))
    })
  }
  // Exercise the named-account service operation with its real profile router.
  const auth = {
    router,
    prepareAccountFolder: (id: string) =>
      ClaudeRuntimeAuthService.prototype.prepareAccountFolder.call(
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the real host-only method reads only this router and target resolver.
        { router, wslRouteFor: () => null } as never,
        id,
        { runtime: 'host' }
      )
  }
  const bin = join(root, 'bin')
  mkdirSync(bin)
  writeFileSync(
    join(bin, 'claude'),
    `#!${process.execPath}\n${readFileSync(join(import.meta.dirname, '__fixtures__/claude-subscription-cli.cjs'), 'utf8')}`,
    { mode: 0o755 }
  )
  const log = join(root, 'attempts.jsonl')
  writeFileSync(log, '')
  const behavior = join(root, 'behavior.json')
  writeFileSync(
    behavior,
    JSON.stringify(options.behavior ?? { a: 'quota', b: 'success', c: 'success', d: 'success' })
  )
  const env = {
    PATH: `${bin}:${dirname(process.execPath)}`,
    CLAUDE_CONFIG_DIR: home('a'),
    ORCA_CLAUDE_INJECTED_CONFIG_DIR: home('a'),
    ORCA_CLAUDE_PROFILE_POINTER: 'must-not-reach-child',
    ORCA_TEST_SUBSCRIPTIONS_LOG: log,
    ORCA_TEST_SUBSCRIPTIONS_BEHAVIOR: behavior,
    ...(options.version ? { ORCA_TEST_CLAUDE_VERSION: options.version } : {})
  }
  const request = beginTextGenerationRequest('branch-name', root, 60000, () => true)
  const params = { agentId: 'claude' as const, model: 'sonnet', thinkingLevel: 'low' }
  const store = { getSettings: () => settings }
  const prepare = createClaudeTextSubscriptionPreparation({
    store,
    auth,
    rateLimits
  })
  const subscription = prepare({ params, cwd: root, env, request })
  const run = async (overrides: Partial<ResolvedSourceControlAiGenerationParams> = {}) => {
    try {
      return await runGenerationRequest({
        params: { ...params, ...overrides },
        prompt: 'Name this fixed context',
        target: {
          kind: 'local',
          cwd: root,
          env,
          request,
          subscription: prepare({ params: { ...params, ...overrides }, cwd: root, env, request })
        },
        operation: 'branch-name',
        spawnAgent: spawnSourceControlAgent
      })
    } finally {
      request.finish()
    }
  }
  return {
    run,
    store,
    root,
    params,
    env,
    request,
    prepare,
    subscription,
    settings,
    auth,
    limits,
    home,
    attempts: () =>
      readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
  }
}
