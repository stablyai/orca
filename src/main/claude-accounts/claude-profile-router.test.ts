import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ClaudeManagedAccount } from '../../shared/managed-account-types'
import type { ClaudeProfileSetupReport } from './claude-profile-setup'
import {
  CLAUDE_PROFILE_MISSING_MESSAGE,
  CLAUDE_PROFILE_SETUP_FAILED_MESSAGE,
  ClaudeProfileRouter,
  type ClaudeProfileRouterSettings
} from './claude-profile-router'
import {
  claudeProfileHistoryDirs,
  installClaudeProfileRouter
} from './claude-profile-installed-router'

const roots: string[] = []
afterEach(() => {
  installClaudeProfileRouter(undefined)
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }))
})

function fixture(env: NodeJS.ProcessEnv = {}) {
  const root = mkdtempSync(join(tmpdir(), 'claude-router-'))
  roots.push(root)
  const userHome = join(root, 'personal')
  const dataRoot = join(root, 'data')
  mkdirSync(join(userHome, '.claude'), { recursive: true })
  const account = (id: string): ClaudeManagedAccount => ({
    id,
    email: `${id}@example.test`,
    authMethod: 'subscription-oauth',
    managedAuthPath: '/unused-legacy',
    createdAt: 0,
    updatedAt: 0,
    lastAuthenticatedAt: 0
  })
  const settings: ClaudeProfileRouterSettings = {
    claudeManagedAccounts: [account('a'), account('b')],
    activeClaudeManagedAccountId: 'a',
    activeClaudeManagedAccountIdsByRuntime: undefined,
    // Hooks off: setup must not probe a real Claude here.
    agentStatusHooksEnabled: false,
    disabledTuiAgents: []
  }
  // Stands in for the worker; each setup stays pending until the test settles it.
  const setup: { calls: number; outcome: ClaudeProfileSetupReport['outcome']; settle: () => void } =
    { calls: 0, outcome: 'prepared', settle: () => {} }
  const runSetup = () => {
    setup.calls += 1
    return new Promise<ClaudeProfileSetupReport>((resolve) => {
      setup.settle = () => resolve({ outcome: setup.outcome, warnings: [], surfaces: {} })
    })
  }
  const router = new ClaudeProfileRouter({
    getSettings: () => settings,
    dataRoot,
    userHome,
    env,
    runSetup
  })
  const home = (id: string) => join(dataRoot, 'claude-profiles', id, 'home')
  return { root, userHome, dataRoot, settings, router, home, setup }
}

describe('ClaudeProfileRouter', () => {
  it('publishes the selected folder, System default as empty, and no file without accounts', () => {
    const f = fixture()
    mkdirSync(f.home('a'), { recursive: true })
    f.router.publish()
    expect(readFileSync(f.router.pointerPath, 'utf8')).toBe(f.home('a'))
    // publish returned while its setup is still running in the background.
    expect(f.setup.calls).toBe(1)

    f.settings.activeClaudeManagedAccountId = null
    f.router.publish()
    expect(readFileSync(f.router.pointerPath, 'utf8')).toBe('')

    f.settings.claudeManagedAccounts = []
    f.router.publish()
    expect(existsSync(f.router.pointerPath)).toBe(false)
  })

  it('makes a launch wait only for a folder that was never set up, reusing the running setup', async () => {
    const f = fixture()
    mkdirSync(f.home('a'), { recursive: true })
    f.router.publish()
    let launched = false
    const launch = f.router.prepareLaunch().then((prepared) => {
      launched = true
      return prepared
    })
    await Promise.resolve()
    expect(launched).toBe(false)
    expect(f.setup.calls).toBe(1)
    f.setup.settle()
    await expect(launch).resolves.toMatchObject({ configDir: f.home('a') })

    f.setup.outcome = 'refused'
    const refused = f.router.prepareLaunch()
    f.setup.settle()
    await expect(refused).rejects.toThrow(CLAUDE_PROFILE_SETUP_FAILED_MESSAGE)

    // Set up once (setup's marker exists): launches stop waiting.
    writeFileSync(join(f.dataRoot, 'claude-profiles', 'a', 'profile.json'), '{}')
    await expect(f.router.prepareLaunch()).resolves.toMatchObject({ configDir: f.home('a') })
    expect(f.setup.calls).toBe(2)
  })

  it('names a never-signed-in folder without creating it, and refuses to launch it', async () => {
    const f = fixture()
    f.settings.activeClaudeManagedAccountId = 'b'
    f.router.publish()
    expect(readFileSync(f.router.pointerPath, 'utf8')).toBe(f.home('b'))
    expect(f.setup.calls).toBe(0)
    expect(existsSync(f.home('b'))).toBe(false)
    expect(() => f.router.preparation()).toThrow(CLAUDE_PROFILE_MISSING_MESSAGE)
    // A terminal still opens; its claude function refuses from the pointer instead.
    expect(f.router.terminalEnv()).toEqual({ ORCA_CLAUDE_PROFILE_POINTER: f.router.pointerPath })
  })

  it('injects the account with its twin, and nothing over the user’s own System default', () => {
    const f = fixture({ CLAUDE_CONFIG_DIR: resolve('/user/own') })
    mkdirSync(f.home('a'), { recursive: true })
    expect(f.router.preparation()).toMatchObject({
      configDir: f.home('a'),
      stripAuthEnv: true,
      envPatch: {
        ORCA_CLAUDE_PROFILE_POINTER: f.router.pointerPath,
        CLAUDE_CONFIG_DIR: f.home('a'),
        ORCA_CLAUDE_INJECTED_CONFIG_DIR: f.home('a')
      }
    })
    f.settings.activeClaudeManagedAccountId = null
    expect(f.router.preparation()).toMatchObject({
      configDir: resolve('/user/own'),
      stripAuthEnv: false,
      envPatch: { ORCA_CLAUDE_PROFILE_POINTER: f.router.pointerPath }
    })
    expect(f.router.preparation().envPatch).not.toHaveProperty('CLAUDE_CONFIG_DIR')
  })

  it('treats a CLAUDE_CONFIG_DIR an outer Orca injected as not the user’s', () => {
    const f = fixture({
      CLAUDE_CONFIG_DIR: '/outer/profile',
      ORCA_CLAUDE_INJECTED_CONFIG_DIR: '/outer/profile'
    })
    expect(f.router.systemDefaultHome()).toBe(join(f.userHome, '.claude'))
  })

  // Why not win32: creating the link needs privileges there.
  it.skipIf(process.platform === 'win32')(
    'lists account history the System default cannot see, skipping linked folders',
    () => {
      const f = fixture()
      expect(claudeProfileHistoryDirs('projects')).toEqual([])
      installClaudeProfileRouter(f.router)
      mkdirSync(join(f.home('a'), 'projects'), { recursive: true })
      mkdirSync(f.home('b'), { recursive: true })
      symlinkSync(join(f.userHome, '.claude'), join(f.home('b'), 'projects'))
      // The pointer file sits among the account folders and must not read as one.
      writeFileSync(join(f.dataRoot, 'claude-profiles', 'selected-host'), '')
      expect(claudeProfileHistoryDirs('projects')).toEqual([join(f.home('a'), 'projects')])
    }
  )
})
