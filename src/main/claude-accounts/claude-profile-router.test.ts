import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ClaudeManagedAccount } from '../../shared/managed-account-types'
import type { ClaudeProfileSetupReport } from './claude-profile-setup'
import {
  claudeProfileMarkerPath,
  describeClaudeProfile,
  prepareClaudeProfileDirectory,
  type ClaudeProfileDescriptor
} from './claude-profile-paths'
import {
  CLAUDE_PROFILE_MISSING_MESSAGE,
  CLAUDE_PROFILE_SETUP_FAILED_MESSAGE
} from '../../shared/claude-profile-routing'
import { getPosixClaudeShellFunction } from '../../shared/claude-shell-function'
import { ClaudeProfileRouter, type ClaudeProfileRouterSettings } from './claude-profile-router'
import {
  claudeProfileHistoryDirs,
  installClaudeProfileRouter
} from './claude-profile-installed-router'

const shell = vi.hoisted(() => ({ hang: false }))
vi.mock('../startup/login-shell-environment', () => ({
  resolveLoginShellEnvironment: () =>
    shell.hang
      ? new Promise(() => {})
      : Promise.resolve({ CLAUDE_CONFIG_DIR: resolve('/shell/own') })
}))
// Account removal must never reach the real Keychain.
vi.mock('../macos-keychain/generic-password', () => ({
  execSecurityCommand: async () => {
    throw new Error('The specified item could not be found in the keychain.')
  }
}))

const roots: string[] = []
afterEach(() => {
  vi.useRealTimers()
  shell.hang = false
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
    // Avoid probing an installed Claude binary.
    agentStatusHooksEnabled: false,
    disabledTuiAgents: []
  }
  const setup: { calls: number; outcome: ClaudeProfileSetupReport['outcome']; settle: () => void } =
    { calls: 0, outcome: 'prepared', settle: () => {} }
  const runSetup = ({ profile }: { profile: ClaudeProfileDescriptor }) => {
    setup.calls += 1
    mkdirSync(profile.home, { recursive: true })
    return new Promise<ClaudeProfileSetupReport>((resolve) => {
      setup.settle = () => {
        if (setup.outcome === 'prepared') {
          writeFileSync(claudeProfileMarkerPath(profile), '{}')
        }
        resolve({ outcome: setup.outcome, warnings: [], surfaces: {} })
      }
    })
  }
  const router = new ClaudeProfileRouter({
    getSettings: () => settings,
    dataRoot,
    userHome,
    env,
    runSetup,
    refreshWaitMs: 500
  })
  const home = (id: string) => join(dataRoot, 'claude-profiles', id, 'home')
  return { root, userHome, dataRoot, settings, router, home, setup }
}

function signIn(stateDir: string, email: string, organizationUuid?: string): void {
  mkdirSync(stateDir, { recursive: true })
  const stateFile = join(stateDir, '.claude.json')
  const previousMtimeMs = existsSync(stateFile) ? statSync(stateFile).mtimeMs : 0
  writeFileSync(
    stateFile,
    JSON.stringify({ oauthAccount: { emailAddress: email, organizationUuid } })
  )
  // Equal-size fixture revisions must invalidate the real reader's mtime cache.
  const mtime = new Date(
    Math.max(
      Math.floor(Date.now() / 1000) * 1000,
      Math.floor(previousMtimeMs / 1000) * 1000 + 2_000
    )
  )
  utimesSync(stateFile, mtime, mtime)
}

async function advanceRefreshDeadline(launch: Promise<unknown>, waitMs: number): Promise<void> {
  let settled = false
  void launch.then(
    () => {
      settled = true
    },
    () => {
      settled = true
    }
  )
  await vi.advanceTimersByTimeAsync(0)
  await vi.advanceTimersByTimeAsync(waitMs - 1)
  expect(settled).toBe(false)
  await vi.advanceTimersByTimeAsync(1)
}

function claudeShellProbe(root: string): (env: Record<string, string>, rc?: string) => string {
  const bin = join(root, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'claude'), '#!/bin/sh\nprintf "%s" "${CLAUDE_CONFIG_DIR-unset}"\n')
  chmodSync(join(bin, 'claude'), 0o700)
  return (env, rc = '') =>
    spawnSync(
      '/bin/bash',
      ['--norc', '--noprofile', '-c', `${getPosixClaudeShellFunction()}\n${rc}claude`],
      { env: { ...env, PATH: `${bin}:/usr/bin:/bin` }, encoding: 'utf8' }
    ).stdout
}

describe('ClaudeProfileRouter', () => {
  it('runs an account with no login of its own on System default while that is signed in to it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const f = fixture()
    mkdirSync(f.home('a'), { recursive: true })
    writeFileSync(join(f.home('a'), '..', 'profile.json'), '{}')
    signIn(f.userHome, 'A@Example.test')
    await expect(f.router.prepareLaunch()).resolves.toMatchObject({
      configDir: join(f.userHome, '.claude'),
      provenance: 'system'
    })
    expect(f.router.preparation().envPatch).not.toHaveProperty('CLAUDE_CONFIG_DIR')
    expect(f.router.terminalEnv()).toEqual({ ORCA_CLAUDE_PROFILE_POINTER: f.router.pointerPath })
    expect(f.router.routedHome()).toBeNull()
    expect(readFileSync(f.router.pointerPath, 'utf8')).toBe('')
    expect(f.router.coveredBySystemDefault('a')).toBe(true)

    signIn(f.home('a'), 'a@example.test')
    const ownFolderLaunch = f.router.prepareLaunch()
    await advanceRefreshDeadline(ownFolderLaunch, 500)
    await expect(ownFolderLaunch).resolves.toMatchObject({
      configDir: f.home('a')
    })
    expect(readFileSync(f.router.pointerPath, 'utf8')).toBe(f.home('a'))
    expect(f.router.coveredBySystemDefault('a')).toBe(false)
  })

  it('tells whether a terminal opened before routing runs another account than the selected one', () => {
    const f = fixture()
    expect(f.router.systemDefaultRunsAnotherAccount()).toBe(true)
    signIn(f.userHome, 'a@example.test')
    expect(f.router.systemDefaultRunsAnotherAccount()).toBe(false)
    const other = fixture()
    signIn(other.userHome, 'a@example.test')
    signIn(other.home('a'), 'someone-else@example.test')
    expect(other.router.systemDefaultRunsAnotherAccount()).toBe(true)
    f.settings.activeClaudeManagedAccountId = null
    expect(f.router.systemDefaultRunsAnotherAccount()).toBeNull()
  })

  it('keeps an account on its own folder when System default is signed in to another email, or out', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const f = fixture()
    mkdirSync(f.home('a'), { recursive: true })
    writeFileSync(join(f.home('a'), '..', 'profile.json'), '{}')
    signIn(f.userHome, 'b@example.test')
    const anotherAccountLaunch = f.router.prepareLaunch()
    await advanceRefreshDeadline(anotherAccountLaunch, 500)
    await expect(anotherAccountLaunch).resolves.toMatchObject({ configDir: f.home('a') })
    writeFileSync(join(f.userHome, '.claude.json'), '{}')
    const signedOutLaunch = f.router.prepareLaunch()
    await advanceRefreshDeadline(signedOutLaunch, 500)
    await expect(signedOutLaunch).resolves.toMatchObject({ configDir: f.home('a') })
  })

  it('never covers an account saved for another organization of the same email', () => {
    const f = fixture()
    f.settings.claudeManagedAccounts = f.settings.claudeManagedAccounts.map((account) => ({
      ...account,
      organizationUuid: account.id === 'a' ? 'org-a' : null
    }))
    signIn(f.userHome, 'a@example.test', 'org-b')
    expect(f.router.coveredBySystemDefault('a')).toBe(false)
    expect(f.router.systemDefaultRunsAnotherAccount()).toBe(true)
    signIn(f.userHome, 'a@example.test', 'org-a')
    expect(f.router.coveredBySystemDefault('a')).toBe(true)
    signIn(f.userHome, 'b@example.test', 'org-b')
    expect(f.router.coveredBySystemDefault('b')).toBe(true)
  })

  it("compares against the user's own CLAUDE_CONFIG_DIR login when they set one", async () => {
    const own = resolve(mkdtempSync(join(tmpdir(), 'claude-router-own-')))
    roots.push(own)
    const f = fixture({ CLAUDE_CONFIG_DIR: own })
    signIn(f.userHome, 'b@example.test')
    signIn(own, 'a@example.test')
    await expect(f.router.prepareLaunch()).resolves.toMatchObject({ configDir: own })
    expect(f.setup.calls).toBe(0)
  })

  it('prepares an account folder for sign-in only when setup succeeds', async () => {
    const f = fixture({ CLAUDE_CONFIG_DIR: resolve('/custom/claude') })
    expect(f.router.accountHome('b')).toBe(f.home('b'))
    expect(f.router.userConfigDir()).toBe(resolve('/custom/claude'))
    const prepared = f.router.prepareAccount('b')
    await vi.waitFor(() => expect(f.setup.calls).toBe(1))
    f.setup.settle()
    await expect(prepared).resolves.toBe(f.home('b'))
    f.setup.outcome = 'refused'
    const refused = f.router.prepareAccount('b')
    await vi.waitFor(() => expect(f.setup.calls).toBe(2))
    f.setup.settle()
    await expect(refused).rejects.toThrow(CLAUDE_PROFILE_SETUP_FAILED_MESSAGE)
  })

  it("reads an older Orca's copy-based switching from the System default snapshot it left", () => {
    const f = fixture()
    expect(f.router.copiedLoginIntoSystemDefault()).toBe(false)
    mkdirSync(join(f.dataRoot, 'claude-runtime-auth'), { recursive: true })
    writeFileSync(join(f.dataRoot, 'claude-runtime-auth', 'system-default-auth.json'), '{}')
    expect(f.router.copiedLoginIntoSystemDefault()).toBe(true)
  })

  it('publishes the selected folder, System default as empty, and no file without accounts', async () => {
    const f = fixture()
    mkdirSync(f.home('a'), { recursive: true })
    f.router.publish()
    expect(readFileSync(f.router.pointerPath, 'utf8')).toBe(f.home('a'))
    await vi.waitFor(() => expect(f.setup.calls).toBe(1))

    f.settings.activeClaudeManagedAccountId = null
    f.router.publish()
    expect(readFileSync(f.router.pointerPath, 'utf8')).toBe('')

    f.settings.claudeManagedAccounts = []
    f.router.publish()
    expect(existsSync(f.router.pointerPath)).toBe(false)
  })

  it('makes a launch wait for a first setup that never ran or is still running, reusing it', async () => {
    const f = fixture()
    mkdirSync(f.home('a'), { recursive: true })
    let launched = false
    const launch = f.router.prepareLaunch().then((prepared) => {
      launched = true
      return prepared
    })
    await vi.waitFor(() => expect(f.setup.calls).toBe(1))
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(launched).toBe(false)
    const second = f.router.prepareLaunch()
    f.setup.outcome = 'refused'
    f.setup.settle()
    await expect(launch).rejects.toMatchObject({ reason: 'claudeAccountSetupFailed' })
    await expect(second).rejects.toThrow(CLAUDE_PROFILE_SETUP_FAILED_MESSAGE)
    expect(f.setup.calls).toBe(1)
  })

  it('refreshes a set-up folder before each launch, which never fails or hangs on it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const f = fixture()
    mkdirSync(f.home('a'), { recursive: true })
    const first = f.router.prepareLaunch()
    await vi.waitFor(() => expect(f.setup.calls).toBe(1))
    f.setup.settle()
    await expect(first).resolves.toMatchObject({ configDir: f.home('a') })

    let launched = false
    const second = f.router.prepareLaunch().then((prepared) => {
      launched = true
      return prepared
    })
    await vi.waitFor(() => expect(f.setup.calls).toBe(2))
    expect(launched).toBe(false)
    f.setup.settle()
    await expect(second).resolves.toMatchObject({ configDir: f.home('a') })

    f.setup.outcome = 'refused'
    const hungRefreshLaunch = f.router.prepareLaunch()
    await advanceRefreshDeadline(hungRefreshLaunch, 500)
    await expect(hungRefreshLaunch).resolves.toMatchObject({ configDir: f.home('a') })
    expect(f.setup.calls).toBe(3)
    f.setup.settle()
    await vi.advanceTimersByTimeAsync(10)
    const fourth = f.router.prepareLaunch()
    await vi.waitFor(() => expect(f.setup.calls).toBe(4))
    f.setup.settle()
    await expect(fourth).resolves.toMatchObject({ configDir: f.home('a') })
  })

  it('makes a launch redo a first setup that was cut off after its ownership gate', async () => {
    const f = fixture()
    mkdirSync(f.home('a'), { recursive: true })
    const profile = describeClaudeProfile(f.dataRoot, 'a', {
      executionHostId: 'local',
      runtime: 'host'
    })
    const cutOff = new ClaudeProfileRouter({
      getSettings: () => f.settings,
      dataRoot: f.dataRoot,
      userHome: f.userHome,
      env: {},
      runSetup: async (args) => {
        prepareClaudeProfileDirectory(args.dataRoot, args.profile, args.userHome)
        throw new Error('Claude account setup timed out')
      }
    })
    await expect(cutOff.prepareLaunch()).rejects.toThrow(CLAUDE_PROFILE_SETUP_FAILED_MESSAGE)
    expect(existsSync(claudeProfileMarkerPath(profile))).toBe(false)

    const launch = f.router.prepareLaunch()
    await vi.waitFor(() => expect(f.setup.calls).toBe(1))
    f.setup.settle()
    await expect(launch).resolves.toMatchObject({ configDir: f.home('a') })
  })

  it("launches a set-up, signed-in account without waiting for the login shell's env", async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    shell.hang = true
    const f = fixture()
    mkdirSync(f.home('a'), { recursive: true })
    writeFileSync(join(f.home('a'), '..', 'profile.json'), '{}')
    signIn(f.home('a'), 'a@example.test')
    const router = new ClaudeProfileRouter({
      getSettings: () => f.settings,
      dataRoot: f.dataRoot,
      userHome: f.userHome
    })
    const launch = router.prepareLaunch()
    await advanceRefreshDeadline(launch, 5_000)
    await expect(launch).resolves.toMatchObject({ configDir: f.home('a') })
  })

  it("sets up a pre-update account's missing folder without a login, for Claude's own first run", async () => {
    const f = fixture()
    f.settings.activeClaudeManagedAccountId = 'b'
    expect(() => f.router.preparation()).toThrow(CLAUDE_PROFILE_MISSING_MESSAGE)
    expect(f.router.terminalEnv()).toEqual({ ORCA_CLAUDE_PROFILE_POINTER: f.router.pointerPath })
    f.router.publish()
    expect(readFileSync(f.router.pointerPath, 'utf8')).toBe(f.home('b'))
    await vi.waitFor(() => expect(f.setup.calls).toBe(1))
    expect(existsSync(f.home('b'))).toBe(true)
    expect(existsSync(join(f.home('b'), '.claude.json'))).toBe(false)
    const launch = f.router.prepareLaunch()
    f.setup.settle()
    await expect(launch).resolves.toMatchObject({ configDir: f.home('b') })
    expect(f.setup.calls).toBe(1)
  })

  it('makes a launch set up a missing folder first', async () => {
    const f = fixture()
    const launch = f.router.prepareLaunch()
    await vi.waitFor(() => expect(f.setup.calls).toBe(1))
    f.setup.settle()
    await expect(launch).resolves.toMatchObject({ configDir: f.home('a') })
  })

  it('injects the account with its twin, and nothing over the user’s own System default', () => {
    const f = fixture({ CLAUDE_CONFIG_DIR: resolve('/user/own') })
    mkdirSync(f.home('a'), { recursive: true })
    expect(f.router.preparation()).toMatchObject({
      configDir: f.home('a'),
      envPatch: {
        ORCA_CLAUDE_PROFILE_POINTER: f.router.pointerPath,
        CLAUDE_CONFIG_DIR: f.home('a'),
        ORCA_CLAUDE_INJECTED_CONFIG_DIR: f.home('a')
      }
    })
    f.settings.activeClaudeManagedAccountId = null
    expect(f.router.preparation()).toMatchObject({
      configDir: resolve('/user/own'),
      envPatch: { ORCA_CLAUDE_PROFILE_POINTER: f.router.pointerPath }
    })
    expect(f.router.preparation().envPatch).not.toHaveProperty('CLAUDE_CONFIG_DIR')
  })

  it('carries the user’s own value exactly as set, since Claude keys its login by that string', () => {
    const f = fixture({ CLAUDE_CONFIG_DIR: 'C:/Claude Config/' })
    f.settings.activeClaudeManagedAccountId = null
    expect(f.router.terminalEnv()).toMatchObject({
      ORCA_CLAUDE_USER_CONFIG_DIR: 'C:/Claude Config/'
    })
  })

  it('carries the user’s own value in every host terminal, beside an injected one too', () => {
    const f = fixture({ CLAUDE_CONFIG_DIR: resolve('/user/own') })
    mkdirSync(f.home('a'), { recursive: true })
    expect(f.router.terminalEnv()).toEqual({
      ORCA_CLAUDE_PROFILE_POINTER: f.router.pointerPath,
      CLAUDE_CONFIG_DIR: f.home('a'),
      ORCA_CLAUDE_INJECTED_CONFIG_DIR: f.home('a'),
      ORCA_CLAUDE_USER_CONFIG_DIR: resolve('/user/own')
    })
    expect(f.router.preparation().envPatch).not.toHaveProperty('ORCA_CLAUDE_USER_CONFIG_DIR')
    f.settings.activeClaudeManagedAccountId = null
    expect(f.router.terminalEnv()).toEqual({
      ORCA_CLAUDE_PROFILE_POINTER: f.router.pointerPath,
      ORCA_CLAUDE_USER_CONFIG_DIR: resolve('/user/own')
    })
    const none = fixture()
    mkdirSync(none.home('a'), { recursive: true })
    expect(none.router.terminalEnv()).not.toHaveProperty('ORCA_CLAUDE_USER_CONFIG_DIR')
  })

  // These probes run the POSIX shell function under Bash.
  it.skipIf(process.platform === 'win32')(
    'gives an account terminal back the inherited CLAUDE_CONFIG_DIR, or none, on System default',
    () => {
      for (const inherited of [{ CLAUDE_CONFIG_DIR: resolve('/user/own') }, {}]) {
        const f = fixture(inherited)
        mkdirSync(f.home('a'), { recursive: true })
        const claude = claudeShellProbe(f.root)
        f.router.publish()
        const pane = { ...inherited, ...f.router.terminalEnv() }
        expect(claude(pane)).toBe(f.home('a'))
        f.settings.activeClaudeManagedAccountId = null
        f.router.publish()
        expect(claude(pane)).toBe(inherited.CLAUDE_CONFIG_DIR ?? 'unset')
      }
    }
  )

  it.skipIf(process.platform === 'win32')(
    'moves a System default terminal whose rc exports the user’s own value to a later selection',
    () => {
      const own = resolve('/user/own')
      const f = fixture({ CLAUDE_CONFIG_DIR: own })
      mkdirSync(f.home('a'), { recursive: true })
      const claude = claudeShellProbe(f.root)
      f.settings.activeClaudeManagedAccountId = null
      f.router.publish()
      const pane = { CLAUDE_CONFIG_DIR: own, ...f.router.terminalEnv() }
      expect(claude(pane)).toBe(own)
      f.settings.activeClaudeManagedAccountId = 'a'
      f.router.publish()
      expect(claude(pane)).toBe(f.home('a'))
      // RC exports run after environment injection.
      const injected = { ...f.router.terminalEnv() }
      expect(claude(injected, `export CLAUDE_CONFIG_DIR='${own}'\n`)).toBe(f.home('a'))
      expect(claude(injected, "export CLAUDE_CONFIG_DIR='/somewhere/else'\n")).toBe(
        '/somewhere/else'
      )
    }
  )

  it('removes a folder only after its running setup, so the setup cannot bring it back', async () => {
    const f = fixture()
    mkdirSync(f.home('a'), { recursive: true })
    f.router.publish()
    await vi.waitFor(() => expect(f.setup.calls).toBe(1))
    const removal = f.router.removeAccount('a')
    await new Promise((resolve) => setTimeout(resolve, 10))
    mkdirSync(f.home('a'), { recursive: true })
    writeFileSync(join(f.home('a'), 'settings.json'), '{}')
    f.setup.settle()
    await removal
    expect(existsSync(join(f.dataRoot, 'claude-profiles', 'a'))).toBe(false)
  })

  it("gives a pane only the pointer until the login shell's env arrives, then rewrites it", async () => {
    const f = fixture()
    mkdirSync(f.home('a'), { recursive: true })
    signIn(f.home('a'), 'a@example.test')
    const router = new ClaudeProfileRouter({
      getSettings: () => f.settings,
      dataRoot: f.dataRoot,
      userHome: f.userHome,
      runSetup: async () => ({ outcome: 'prepared', warnings: [], surfaces: {} })
    })
    expect(router.terminalEnv()).toEqual({ ORCA_CLAUDE_PROFILE_POINTER: router.pointerPath })
    await vi.waitFor(() => expect(readFileSync(router.pointerPath, 'utf8')).toBe(f.home('a')))
    expect(router.terminalEnv()).toMatchObject({ CLAUDE_CONFIG_DIR: f.home('a') })
  })

  it('takes System default from the login shell, which a Dock launch does not inherit', async () => {
    const f = fixture()
    f.settings.activeClaudeManagedAccountId = null
    const router = new ClaudeProfileRouter({
      getSettings: () => f.settings,
      dataRoot: f.dataRoot,
      userHome: f.userHome
    })
    await expect(router.prepareLaunch()).resolves.toMatchObject({
      configDir: resolve('/shell/own'),
      provenance: 'system'
    })
  })

  it('treats a CLAUDE_CONFIG_DIR an outer Orca injected as not the user’s', () => {
    const f = fixture({
      CLAUDE_CONFIG_DIR: '/outer/profile',
      ORCA_CLAUDE_INJECTED_CONFIG_DIR: '/outer/profile'
    })
    expect(f.router.systemDefaultHome()).toBe(join(f.userHome, '.claude'))
    const carried = fixture({
      CLAUDE_CONFIG_DIR: '/outer/profile',
      ORCA_CLAUDE_INJECTED_CONFIG_DIR: '/outer/profile',
      ORCA_CLAUDE_USER_CONFIG_DIR: '/user/own'
    })
    expect(carried.router.systemDefaultHome()).toBe(resolve('/user/own'))
  })

  // Creating real symlinks requires additional Windows privileges.
  it.skipIf(process.platform === 'win32')(
    'lists account history the System default cannot see, skipping linked folders',
    () => {
      const f = fixture()
      expect(claudeProfileHistoryDirs('projects')).toEqual([])
      installClaudeProfileRouter(f.router)
      mkdirSync(join(f.home('a'), 'projects'), { recursive: true })
      mkdirSync(f.home('b'), { recursive: true })
      symlinkSync(join(f.userHome, '.claude'), join(f.home('b'), 'projects'))
      writeFileSync(join(f.dataRoot, 'claude-profiles', 'selected-host'), '')
      expect(claudeProfileHistoryDirs('projects')).toEqual([join(f.home('a'), 'projects')])
    }
  )
})
