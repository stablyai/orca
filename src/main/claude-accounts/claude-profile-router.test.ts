import { spawnSync } from 'node:child_process'
import {
  chmodSync,
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

// Why: removal deletes macOS Keychain items; the test must never reach the real Keychain.
// The login shell exports what a Dock launch's own env lacks.
const shell = vi.hoisted(() => ({ hang: false }))
vi.mock('../startup/login-shell-environment', () => ({
  resolveLoginShellEnvironment: () =>
    shell.hang
      ? new Promise(() => {})
      : Promise.resolve({ CLAUDE_CONFIG_DIR: resolve('/shell/own') })
}))
vi.mock('../macos-keychain/generic-password', () => ({
  execSecurityCommand: async () => {
    throw new Error('The specified item could not be found in the keychain.')
  }
}))

const roots: string[] = []
afterEach(() => {
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
    // Hooks off: setup must not probe a real Claude here.
    agentStatusHooksEnabled: false,
    disabledTuiAgents: []
  }
  // Stands in for the worker; like it, stays pending until settled and marks the folder last.
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
    runSetup
  })
  const home = (id: string) => join(dataRoot, 'claude-profiles', id, 'home')
  return { root, userHome, dataRoot, settings, router, home, setup }
}

describe('ClaudeProfileRouter', () => {
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
    // publish returned while its setup is still running in the background.
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

  it('never makes a launch wait on, or fail with, a re-run of a set-up folder', async () => {
    const f = fixture()
    mkdirSync(f.home('a'), { recursive: true })
    const first = f.router.prepareLaunch()
    await vi.waitFor(() => expect(f.setup.calls).toBe(1))
    f.setup.settle()
    await expect(first).resolves.toMatchObject({ configDir: f.home('a') })

    // Startup or a switch re-runs setup; it stays pending, then fails.
    f.setup.outcome = 'refused'
    f.router.publish()
    await vi.waitFor(() => expect(f.setup.calls).toBe(2))
    await expect(f.router.prepareLaunch()).resolves.toMatchObject({ configDir: f.home('a') })
    f.setup.settle()
    await new Promise((resolve) => setTimeout(resolve, 10))
    await expect(f.router.prepareLaunch()).resolves.toMatchObject({ configDir: f.home('a') })
    expect(f.setup.calls).toBe(2)
  })

  it('makes a launch redo a first setup that was cut off after its ownership gate', async () => {
    const f = fixture()
    mkdirSync(f.home('a'), { recursive: true })
    const profile = describeClaudeProfile(f.dataRoot, 'a', {
      executionHostId: 'local',
      runtime: 'host'
    })
    // The worker timed out, or the app quit, after the gate ran.
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

  it("launches a set-up account without waiting for the login shell's env", async () => {
    shell.hang = true
    const f = fixture()
    mkdirSync(f.home('a'), { recursive: true })
    writeFileSync(join(f.home('a'), '..', 'profile.json'), '{}')
    const router = new ClaudeProfileRouter({
      getSettings: () => f.settings,
      dataRoot: f.dataRoot,
      userHome: f.userHome
    })
    await expect(router.prepareLaunch()).resolves.toMatchObject({ configDir: f.home('a') })
  })

  it("sets up a pre-update account's missing folder without a login, for Claude's own first run", async () => {
    const f = fixture()
    f.settings.activeClaudeManagedAccountId = 'b'
    // Before its setup, a terminal still opens; its claude function creates the folder itself.
    expect(() => f.router.preparation()).toThrow(CLAUDE_PROFILE_MISSING_MESSAGE)
    expect(f.router.terminalEnv()).toEqual({ ORCA_CLAUDE_PROFILE_POINTER: f.router.pointerPath })
    f.router.publish()
    expect(readFileSync(f.router.pointerPath, 'utf8')).toBe(f.home('b'))
    await vi.waitFor(() => expect(f.setup.calls).toBe(1))
    expect(existsSync(f.home('b'))).toBe(true)
    // Claude's first run is clean only without an onboarding-done state file.
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

  it('carries the user’s own value beside an account terminal’s injected one', () => {
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
    expect(f.router.terminalEnv()).toEqual({ ORCA_CLAUDE_PROFILE_POINTER: f.router.pointerPath })
    const none = fixture()
    mkdirSync(none.home('a'), { recursive: true })
    expect(none.router.terminalEnv()).not.toHaveProperty('ORCA_CLAUDE_USER_CONFIG_DIR')
  })

  // Why not win32: runs the POSIX claude function under bash.
  it.skipIf(process.platform === 'win32')(
    'gives an account terminal back the inherited CLAUDE_CONFIG_DIR, or none, on System default',
    () => {
      for (const inherited of [{ CLAUDE_CONFIG_DIR: resolve('/user/own') }, {}]) {
        const f = fixture(inherited)
        mkdirSync(f.home('a'), { recursive: true })
        const bin = join(f.root, 'bin')
        mkdirSync(bin)
        writeFileSync(join(bin, 'claude'), '#!/bin/sh\nprintf "%s" "${CLAUDE_CONFIG_DIR-unset}"\n')
        chmodSync(join(bin, 'claude'), 0o700)
        const claude = (env: Record<string, string>): string =>
          spawnSync(
            '/bin/bash',
            ['--norc', '--noprofile', '-c', `${getPosixClaudeShellFunction()}\nclaude`],
            { env: { ...env, PATH: `${bin}:/usr/bin:/bin` }, encoding: 'utf8' }
          ).stdout
        // The pane opens while account A is selected, so Orca replaces the inherited value.
        f.router.publish()
        const pane = { ...inherited, ...f.router.terminalEnv() }
        expect(claude(pane)).toBe(f.home('a'))
        f.settings.activeClaudeManagedAccountId = null
        f.router.publish()
        expect(claude(pane)).toBe(inherited.CLAUDE_CONFIG_DIR ?? 'unset')
      }
    }
  )

  it('removes a folder only after its running setup, so the setup cannot bring it back', async () => {
    const f = fixture()
    mkdirSync(f.home('a'), { recursive: true })
    f.router.publish()
    await vi.waitFor(() => expect(f.setup.calls).toBe(1))
    const removal = f.router.removeAccount('a')
    await new Promise((resolve) => setTimeout(resolve, 10))
    // Setup writes into the folder before it settles, as the worker does.
    mkdirSync(f.home('a'), { recursive: true })
    writeFileSync(join(f.home('a'), 'settings.json'), '{}')
    f.setup.settle()
    await removal
    expect(existsSync(join(f.dataRoot, 'claude-profiles', 'a'))).toBe(false)
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
