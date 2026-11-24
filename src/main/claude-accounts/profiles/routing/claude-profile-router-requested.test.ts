import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ClaudeProfileRouter } from './claude-profile-router'
import { claudeProfileMarkerPath, describeClaudeProfile } from '../claude-profile-paths'

let root: string

function account(id: string) {
  return {
    id,
    email: `${id}@example.com`,
    managedAuthPath: join(root, id),
    authMethod: 'subscription-oauth' as const,
    createdAt: 1,
    updatedAt: 1,
    lastAuthenticatedAt: 1
  }
}

function makeRouter(selected: string | null): ClaudeProfileRouter {
  return new ClaudeProfileRouter({
    dataRoot: root,
    userHome: join(root, 'home'),
    env: {},
    getSettings: () => ({
      claudeManagedAccounts: [account('a1'), account('a2')],
      activeClaudeManagedAccountId: selected,
      activeClaudeManagedAccountIdsByRuntime: { host: selected, wsl: {} },
      agentStatusHooksEnabled: false,
      disabledTuiAgents: []
    }),
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the router only reads the outcome
    runSetup: async () => ({ outcome: 'prepared', warnings: [] }) as never
  })
}

function prepareFolder(id: string): string {
  const profile = describeClaudeProfile(root, id, { executionHostId: 'local', runtime: 'host' })
  mkdirSync(profile.home, { recursive: true })
  writeFileSync(claudeProfileMarkerPath(profile), '{}')
  return profile.home
}

describe('ClaudeProfileRouter.prepareLaunch with a requested account', () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'claude-router-requested-'))
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('launches under the requested account and leaves the host selection and pointer alone', async () => {
    const home1 = prepareFolder('a1')
    prepareFolder('a2')
    const router = makeRouter('a2')
    const prepared = await router.prepareLaunch({ kind: 'managed', accountId: 'a1' })
    expect(prepared.configDir).toBe(home1)
    expect(prepared.provenance).toBe('profile:a1')
    expect(prepared.envPatch.CLAUDE_CONFIG_DIR).toBe(home1)
    expect(existsSync(router.pointerPath)).toBe(false)
    expect((await router.prepareLaunch()).provenance).toBe('profile:a2')
  })

  it('launches the System default while a managed account is selected', async () => {
    prepareFolder('a2')
    const router = makeRouter('a2')
    const prepared = await router.prepareLaunch({ kind: 'system' })
    expect(prepared.provenance).toBe('system')
    expect(prepared.configDir).toBe(router.systemDefaultHome())
    expect(prepared.envPatch.CLAUDE_CONFIG_DIR).toBeUndefined()
  })
})
