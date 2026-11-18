import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ClaudeProfileRouter, type ClaudeProfileRouterSettings } from './claude-profile-router'
import { ClaudeWorkspaceProfiles } from './claude-workspace-profile'
import {
  installClaudeProfileRouter,
  installClaudeWorkspaceProfiles
} from './claude-profile-installed-router'
import { claudeStateFile } from '../../sign-in/claude-account-folder'
import { prepareClaudeLaunchAccount } from '../../../claude/structured/launch/claude-launch-account'

vi.mock('../../../codex-cli/command', () => ({ resolveClaudeCommand: () => '/unused' }))
let root: string
let settings: ClaudeProfileRouterSettings
let router: ClaudeProfileRouter
let profiles: ClaudeWorkspaceProfiles
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-claude-workspace-'))
  mkdirSync(join(root, 'user', '.claude'), { recursive: true })
  settings = {
    claudeManagedAccounts: ['personal', 'work'].map((id) => ({
      id,
      email: `${id}@example.test`,
      managedAuthPath: '/legacy-unused',
      authMethod: 'subscription-oauth',
      createdAt: 0,
      updatedAt: 0,
      lastAuthenticatedAt: 0
    })),
    activeClaudeManagedAccountId: 'personal',
    claudeWorkspaceAccounts: { 'folder:client': 'work' },
    agentStatusHooksEnabled: false,
    disabledTuiAgents: []
  }
  router = new ClaudeProfileRouter({
    dataRoot: join(root, 'data'),
    userHome: join(root, 'user'),
    env: {},
    getSettings: () => settings
  })
  for (const id of ['personal', 'work']) {
    mkdirSync(router.accountHome(id), { recursive: true })
    writeFileSync(
      claudeStateFile(router.accountHome(id)),
      JSON.stringify({ oauthAccount: { emailAddress: `${id}@example.test` } })
    )
  }
  profiles = new ClaudeWorkspaceProfiles(
    () => settings,
    router,
    async (id) => ({ configDir: router.accountHome(id), readPath: router.accountHome(id) })
  )
  installClaudeWorkspaceProfiles(profiles)
})
afterEach(() => {
  installClaudeProfileRouter(undefined)
  rmSync(root, { recursive: true, force: true })
})

it('pins terminal and structured launches to the workspace account while the host default differs', async () => {
  const prepared = await profiles.resolve('folder:client', { runtime: 'host' }, true)
  expect(prepared?.envPatch.CLAUDE_CONFIG_DIR).toBe(router.accountHome('work'))
  expect(prepared?.envPatch.ORCA_CLAUDE_PROFILE_POINTER).toBe('')
  const env = { CLAUDE_CONFIG_DIR: router.accountHome('personal') }
  const recipe = await prepareClaudeLaunchAccount(
    router,
    env,
    router.accountHome('personal'),
    'folder:client'
  )
  expect(recipe).toEqual({ route: 'managed', accountId: 'work', home: router.accountHome('work') })
  expect(env.CLAUDE_CONFIG_DIR).toBe(router.accountHome('work'))
  expect(settings.activeClaudeManagedAccountId).toBe('personal')
  expect(await profiles.resolve('folder:other', { runtime: 'host' }, true)).toBeNull()
})

it('refuses fallback to a valid system login when the pinned account is signed out', async () => {
  writeFileSync(
    claudeStateFile(join(root, 'user', '.claude')),
    '{"oauthAccount":{"emailAddress":"work@example.test"}}'
  )
  rmSync(claudeStateFile(router.accountHome('work')))
  await expect(profiles.resolve('folder:client', { runtime: 'host' }, true)).rejects.toThrow(
    'not signed in to its own profile'
  )
  expect(
    JSON.parse(readFileSync(claudeStateFile(join(root, 'user', '.claude')), 'utf8')).oauthAccount
      .emailAddress
  ).toBe('work@example.test')
})

it('leaves another runtime to its own account lane instead of using the host binding', async () => {
  await expect(
    profiles.resolve('folder:client', { runtime: 'wsl', wslDistro: 'Ubuntu' }, true)
  ).resolves.toBeNull()
})

it('names a signed-out workspace profile for identity but refuses to launch it', async () => {
  rmSync(claudeStateFile(router.accountHome('work')))
  const identity = await profiles.resolve('folder:client', { runtime: 'host' }, false, 'identity')
  expect(identity?.configDir).toBe(router.accountHome('work'))
  await expect(profiles.resolve('folder:client', { runtime: 'host' }, true)).rejects.toThrow(
    'not signed in'
  )
})
