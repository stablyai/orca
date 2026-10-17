import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ClaudeManagedAccount } from '../../shared/managed-account-types'
import type { ClaudeProfileSetupReport } from './claude-profile-setup'
import { claudeProfileMarkerPath, type ClaudeProfileDescriptor } from './claude-profile-paths'
import {
  CLAUDE_PROFILE_SETUP_FAILED_MESSAGE,
  CLAUDE_REMOVED_ACCOUNT_POINTER
} from '../../shared/claude-profile-routing'
import { ClaudeProfileRouter, type ClaudeProfileRouterSettings } from './claude-profile-router'
import {
  claudeTerminalEnvForAccount,
  prepareClaudeLaunchForAccount,
  removeClaudeAccountFolder
} from './claude-profile-account-route'

vi.mock('../startup/login-shell-environment', () => ({
  resolveLoginShellEnvironment: () => Promise.resolve({})
}))
// Why: removal deletes macOS Keychain items; the test must never reach the real Keychain.
vi.mock('../macos-keychain/generic-password', () => ({
  execSecurityCommand: async () => {
    throw new Error('The specified item could not be found in the keychain.')
  }
}))

const roots: string[] = []
afterEach(() => {
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }))
})

function account(id: string): ClaudeManagedAccount {
  return {
    id,
    email: `${id}@example.com`,
    authMethod: 'subscription-oauth',
    managedAuthPath: '/unused-legacy',
    createdAt: 0,
    updatedAt: 0,
    lastAuthenticatedAt: 0
  }
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'claude-account-pointers-'))
  roots.push(root)
  const userHome = join(root, 'personal')
  const dataRoot = join(root, 'data')
  mkdirSync(join(userHome, '.claude'), { recursive: true })
  const settings: ClaudeProfileRouterSettings = {
    claudeManagedAccounts: [account('a'), account('b'), account('c')],
    activeClaudeManagedAccountId: 'b',
    activeClaudeManagedAccountIdsByRuntime: undefined,
    agentStatusHooksEnabled: false,
    disabledTuiAgents: []
  }
  const setup: { outcome: ClaudeProfileSetupReport['outcome'] } = { outcome: 'prepared' }
  const runSetup = async ({ profile }: { profile: ClaudeProfileDescriptor }) => {
    mkdirSync(profile.home, { recursive: true })
    if (setup.outcome === 'prepared') {
      writeFileSync(claudeProfileMarkerPath(profile), '{}')
    }
    return { outcome: setup.outcome, warnings: [], surfaces: {} } satisfies ClaudeProfileSetupReport
  }
  const router = new ClaudeProfileRouter({
    getSettings: () => settings,
    dataRoot,
    userHome,
    env: {},
    runSetup,
    refreshWaitMs: 50
  })
  const home = (id: string) => join(dataRoot, 'claude-profiles', id, 'home')
  const pointer = (id: string) => join(dataRoot, 'claude-profile-pointers', `account-${id}`)
  return { root, userHome, dataRoot, settings, router, home, pointer, setup }
}

function signIn(stateDir: string, email: string): void {
  mkdirSync(stateDir, { recursive: true })
  const stateFile = join(stateDir, '.claude.json')
  const previous = existsSync(stateFile) ? statSync(stateFile).mtimeMs : 0
  writeFileSync(stateFile, JSON.stringify({ oauthAccount: { emailAddress: email } }))
  const mtime = new Date(Math.max(Date.now(), previous + 2_000))
  utimesSync(stateFile, mtime, mtime)
}

describe('per-account Claude pointers', () => {
  it('routes an account to its own folder, or to System default while that covers it', () => {
    const f = fixture()
    signIn(f.home('a'), 'a@example.com')
    signIn(f.userHome, 'b@example.com')
    const pointers = f.router.accountPointers

    expect(pointers.routeFor('a')).toBe(f.home('a'))
    expect(pointers.routeFor('b')).toBe('')
    expect(pointers.routeFor('gone')).toBeNull()
  })

  it('writes only when the route changed', () => {
    const f = fixture()
    signIn(f.home('a'), 'a@example.com')
    const pointers = f.router.accountPointers
    pointers.update('a')
    expect(readFileSync(f.pointer('a'), 'utf8')).toBe(f.home('a'))
    expect(statSync(f.pointer('a')).mode & 0o777).toBe(0o600)
    const old = new Date(Date.now() - 60_000)
    utimesSync(f.pointer('a'), old, old)

    pointers.update('a')

    expect(statSync(f.pointer('a')).mtimeMs).toBe(old.getTime())
  })

  it('follows an existing file when coverage changes, on the next selection write', () => {
    const f = fixture()
    signIn(f.userHome, 'a@example.com')
    f.router.accountPointers.update('a')
    expect(readFileSync(f.pointer('a'), 'utf8')).toBe('')

    signIn(f.home('a'), 'a@example.com')
    f.router.publish()

    expect(readFileSync(f.pointer('a'), 'utf8')).toBe(f.home('a'))
  })

  it('creates nothing for people who never kept an agent', async () => {
    const f = fixture()
    f.router.publish()
    await f.router.prepareLaunch()
    f.router.terminalEnv()
    expect(existsSync(join(f.dataRoot, 'claude-profile-pointers'))).toBe(false)
  })

  it("points a removed account's file at no folder before deleting, and never deletes it", async () => {
    const f = fixture()
    signIn(f.home('a'), 'a@example.com')
    f.router.accountPointers.update('a')
    const removeAccount = vi.spyOn(f.router, 'removeAccount')
    let pointerDuringDelete = ''
    removeAccount.mockImplementation(async () => {
      pointerDuringDelete = readFileSync(f.pointer('a'), 'utf8')
    })

    await removeClaudeAccountFolder(f.router, 'a')
    // A write racing the removal must not point the file back at the folder.
    f.router.publish()
    f.settings.claudeManagedAccounts = []
    f.router.publish()

    expect(pointerDuringDelete).toBe(CLAUDE_REMOVED_ACCOUNT_POINTER)
    expect(readFileSync(f.pointer('a'), 'utf8')).toBe(CLAUDE_REMOVED_ACCOUNT_POINTER)
    expect(f.router.accountPointers.routeFor('a')).toBeNull()
  })

  it('refuses a kept launch on an account while its folder is being removed', async () => {
    const f = fixture()
    signIn(f.home('a'), 'a@example.com')
    f.router.accountPointers.update('a')
    let launchDuringDelete: Promise<unknown> = Promise.resolve()
    let envDuringDelete: unknown
    vi.spyOn(f.router, 'removeAccount').mockImplementation(async () => {
      // The account is still saved here: settings drop it only after the folder is gone.
      envDuringDelete = claudeTerminalEnvForAccount(f.router, 'a')
      rmSync(join(f.dataRoot, 'claude-profiles', 'a'), { recursive: true, force: true })
      launchDuringDelete = prepareClaudeLaunchForAccount(f.router, 'a')
    })

    await removeClaudeAccountFolder(f.router, 'a')

    await expect(launchDuringDelete).rejects.toThrow(/no longer saved/)
    expect(envDuringDelete).toEqual({ ORCA_CLAUDE_PROFILE_POINTER: f.pointer('a') })
    expect(existsSync(join(f.dataRoot, 'claude-profiles', 'a'))).toBe(false)
    expect(readFileSync(f.pointer('a'), 'utf8')).toBe(CLAUDE_REMOVED_ACCOUNT_POINTER)
  })

  it("starts the selection even when a kept account's file cannot be rewritten", async () => {
    const f = fixture()
    mkdirSync(f.pointer('a'), { recursive: true })
    signIn(f.home('b'), 'b@example.com')

    await expect(f.router.prepareLaunch()).resolves.toMatchObject({ configDir: f.home('b') })
    expect(readFileSync(f.router.pointerPath, 'utf8')).toBe(f.home('b'))
  })

  it('points the file back at the account when its removal fails', async () => {
    const f = fixture()
    signIn(f.home('a'), 'a@example.com')
    f.router.accountPointers.update('a')
    vi.spyOn(f.router, 'removeAccount').mockRejectedValue(new Error('folder in use'))

    await expect(removeClaudeAccountFolder(f.router, 'a')).rejects.toThrow('folder in use')

    expect(readFileSync(f.pointer('a'), 'utf8')).toBe(f.home('a'))
  })

  it("never hands a kept pane the selection's pointer, even with a missing folder", () => {
    const f = fixture()
    expect(claudeTerminalEnvForAccount(f.router, 'a')).toEqual({
      ORCA_CLAUDE_PROFILE_POINTER: f.pointer('a')
    })
    expect(claudeTerminalEnvForAccount(f.router, null)).toEqual({
      ORCA_CLAUDE_PROFILE_POINTER: join(f.dataRoot, 'claude-profile-pointers', 'system-default')
    })
    expect(claudeTerminalEnvForAccount(f.router, '../x')).toEqual({
      ORCA_CLAUDE_PROFILE_POINTER: join(f.dataRoot, 'claude-profile-pointers', 'system-default')
    })
  })

  it('injects the kept account with its twin once its folder exists', () => {
    const f = fixture()
    signIn(f.home('a'), 'a@example.com')
    expect(claudeTerminalEnvForAccount(f.router, 'a')).toEqual({
      ORCA_CLAUDE_PROFILE_POINTER: f.pointer('a'),
      CLAUDE_CONFIG_DIR: f.home('a'),
      ORCA_CLAUDE_INJECTED_CONFIG_DIR: f.home('a')
    })
  })
})

describe('prepareClaudeLaunchForAccount', () => {
  it('launches on the kept account while another one is selected', async () => {
    const f = fixture()
    signIn(f.home('a'), 'a@example.com')

    await expect(prepareClaudeLaunchForAccount(f.router, 'a')).resolves.toEqual({
      configDir: f.home('a'),
      runtime: 'host',
      wslDistro: null,
      wslLinuxConfigDir: null,
      envPatch: {
        ORCA_CLAUDE_PROFILE_POINTER: f.pointer('a'),
        CLAUDE_CONFIG_DIR: f.home('a'),
        ORCA_CLAUDE_INJECTED_CONFIG_DIR: f.home('a')
      },
      provenance: 'profile:a'
    })
    expect(readFileSync(f.pointer('a'), 'utf8')).toBe(f.home('a'))
    expect(existsSync(f.router.pointerPath)).toBe(false)
  })

  it('launches System default with its own file and leaves the user value alone', async () => {
    const f = fixture()
    await expect(prepareClaudeLaunchForAccount(f.router, null)).resolves.toMatchObject({
      configDir: resolve(f.userHome, '.claude'),
      envPatch: {
        ORCA_CLAUDE_PROFILE_POINTER: join(f.dataRoot, 'claude-profile-pointers', 'system-default')
      },
      provenance: 'system'
    })
  })

  it('refuses when the first setup fails, or the account is no longer saved', async () => {
    const f = fixture()
    f.setup.outcome = 'refused'
    await expect(prepareClaudeLaunchForAccount(f.router, 'a')).rejects.toThrow(
      CLAUDE_PROFILE_SETUP_FAILED_MESSAGE
    )
    await expect(prepareClaudeLaunchForAccount(f.router, 'gone')).rejects.toThrow(/no longer saved/)
  })
})
