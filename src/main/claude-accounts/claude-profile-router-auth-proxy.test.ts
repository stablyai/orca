import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ClaudeManagedAccount } from '../../shared/managed-account-types'
import {
  startClaudeAuthProxy,
  stopClaudeAuthProxy
} from './claude-auth-proxy/claude-auth-proxy-host'
import { resetUserAnthropicBaseUrlNote } from './claude-auth-proxy/claude-auth-proxy-note'
import { ClaudeProfileRouter, type ClaudeProfileRouterSettings } from './claude-profile-router'
import { _internals, rememberClaudeSessionAssignment } from './claude-pane-account-registry'

const roots: string[] = []

afterEach(async () => {
  resetUserAnthropicBaseUrlNote()
  _internals.reset()
  await stopClaudeAuthProxy()
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function routerFor(env: NodeJS.ProcessEnv = {}) {
  const root = mkdtempSync(join(tmpdir(), 'claude-auth-proxy-router-'))
  roots.push(root)
  const account = (id: string): ClaudeManagedAccount => ({
    id,
    email: `${id}@example.test`,
    authMethod: 'subscription-oauth',
    managedAuthPath: '/unused',
    createdAt: 0,
    updatedAt: 0,
    lastAuthenticatedAt: 0
  })
  const settings: ClaudeProfileRouterSettings = {
    claudeManagedAccounts: [account('a'), account('b')],
    activeClaudeManagedAccountId: 'a',
    activeClaudeManagedAccountIdsByRuntime: undefined,
    agentStatusHooksEnabled: false,
    disabledTuiAgents: [],
    claudeAuthProxy: true
  }
  const router = new ClaudeProfileRouter({
    getSettings: () => settings,
    dataRoot: join(root, 'data'),
    userHome: join(root, 'home'),
    env,
    runSetup: () => Promise.resolve({ outcome: 'prepared', warnings: [], surfaces: {} })
  })
  mkdirSync(router.accountHome('a'), { recursive: true })
  mkdirSync(router.accountHome('b'), { recursive: true })
  return { router, settings }
}

describe('ClaudeProfileRouter auth proxy launch env', () => {
  it('points launchEnv and launchEnvFor at a per-pane slot while the proxy is on', async () => {
    await startClaudeAuthProxy()
    const { router } = routerFor()
    const selected = router.launchEnv().ANTHROPIC_BASE_URL
    const named = router.launchEnvFor('b').ANTHROPIC_BASE_URL
    const prepared = router.preparationFor('b').envPatch.ANTHROPIC_BASE_URL
    const launched = (await router.prepareLaunchFor('b')).envPatch.ANTHROPIC_BASE_URL
    for (const url of [selected, named, prepared, launched]) {
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/p\/[0-9a-f]+\/$/)
    }
    expect(new Set([selected, named, prepared, launched]).size).toBe(4)
  })

  it('leaves the launch env alone when the setting is absent', async () => {
    await startClaudeAuthProxy()
    const { router, settings } = routerFor()
    delete settings.claudeAuthProxy
    expect(router.launchEnv().ANTHROPIC_BASE_URL).toBeUndefined()
  })

  it('leaves the launch env alone when the setting is off', async () => {
    await startClaudeAuthProxy()
    const { router, settings } = routerFor()
    settings.claudeAuthProxy = false
    expect(router.launchEnv().ANTHROPIC_BASE_URL).toBeUndefined()
    expect(router.launchEnvFor('b')).toEqual({ CLAUDE_CONFIG_DIR: router.accountHome('b') })
  })

  it('does not replace a user-set ANTHROPIC_BASE_URL, and says so once', async () => {
    await startClaudeAuthProxy()
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const { router } = routerFor({ ANTHROPIC_BASE_URL: 'https://gateway.example' })
    expect(router.launchEnv().ANTHROPIC_BASE_URL).toBeUndefined()
    expect(router.launchEnvFor('b').ANTHROPIC_BASE_URL).toBeUndefined()
    const notes = info.mock.calls.filter((call) =>
      String(call[0]).includes('ANTHROPIC_BASE_URL is already set')
    )
    expect(notes).toHaveLength(1)
    info.mockRestore()
  })

  it('relaunches a remembered session on the account the proxy billed', () => {
    const { router } = routerFor()
    expect(router.assignedAccountForResume('sess-1')).toBeNull()
    rememberClaudeSessionAssignment('sess-1', 'b')
    expect(router.assignedAccountForResume('sess-1')).toBe('b')
  })
})
