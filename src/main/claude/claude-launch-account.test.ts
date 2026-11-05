import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import {
  ClaudeProfileRouter,
  type ClaudeProfileRouterSettings
} from '../claude-accounts/claude-profile-router'
import { installClaudeProfileRouter } from '../claude-accounts/claude-profile-installed-router'
import { claudeProfileMarkerPath } from '../claude-accounts/claude-profile-paths'
import { resolveStructuredClaudeAccountHomePath } from '../runtime/agent-session/environment/structured-agent-account-home'
import { prepareClaudeLaunchAccount } from './claude-launch-account'

const roots: string[] = []
afterEach(() => {
  installClaudeProfileRouter(undefined)
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }))
})

const account = (id: string) => ({
  id,
  email: `${id}@example.test`,
  authMethod: 'subscription-oauth' as const,
  managedAuthPath: '/unused',
  createdAt: 0,
  updatedAt: 0,
  lastAuthenticatedAt: 0
})

it("launches a pinned project's chat on its account and reads that same home back, so sends never retire it", async () => {
  const root = mkdtempSync(join(tmpdir(), 'claude-chat-pin-'))
  roots.push(root)
  const settings: ClaudeProfileRouterSettings = {
    claudeManagedAccounts: [account('a'), account('b')],
    activeClaudeManagedAccountId: 'a',
    activeClaudeManagedAccountIdsByRuntime: undefined,
    agentStatusHooksEnabled: false,
    disabledTuiAgents: []
  }
  const router = new ClaudeProfileRouter({
    getSettings: () => settings,
    dataRoot: join(root, 'data'),
    userHome: join(root, 'personal'),
    env: {},
    runSetup: async ({ profile }) => {
      mkdirSync(profile.home, { recursive: true })
      writeFileSync(claudeProfileMarkerPath(profile), '{}')
      return { outcome: 'prepared', warnings: [], surfaces: {} }
    },
    getProjectAccountId: (worktreeId) => (worktreeId === 'work::/repo' ? 'b' : undefined)
  })
  installClaudeProfileRouter(router)
  // The read the outgrown check compares a running chat against before each send.
  const desiredHome = (worktreeId: string) =>
    resolveStructuredClaudeAccountHomePath({
      launchEnv: {},
      wslDistro: null,
      worktreeId,
      getClaudeConfigDirectory: () => router.systemDefaultHome()
    })

  const pinned = await prepareClaudeLaunchAccount(router, {}, '/record', 'work::/repo')
  const homeB = join(root, 'data', 'claude-profiles', 'b', 'home')
  expect(pinned).toMatchObject({ route: 'managed', accountId: 'b', home: homeB })
  expect(await desiredHome('work::/repo')).toBe(homeB)

  const other = await prepareClaudeLaunchAccount(router, {}, '/record', 'personal::/repo')
  const homeA = join(root, 'data', 'claude-profiles', 'a', 'home')
  expect(other).toMatchObject({ route: 'managed', accountId: 'a', home: homeA })
  expect(await desiredHome('personal::/repo')).toBe(homeA)

  // Moving the selection leaves the pinned chat where it runs.
  settings.activeClaudeManagedAccountId = null
  expect(await desiredHome('work::/repo')).toBe(homeB)
})
