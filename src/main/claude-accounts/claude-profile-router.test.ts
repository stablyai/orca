import { spawnSync } from 'node:child_process'
import {
  chmodSync,
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
import {
  claudeProfileMarkerPath,
  describeClaudeProfile,
  prepareClaudeProfileDirectory,
  type ClaudeProfileDescriptor
} from './claude-profile-paths'
import { CLAUDE_PROFILE_SETUP_FAILED_MESSAGE } from '../../shared/claude-profile-routing'
import { getPosixClaudeShellFunction } from '../../shared/claude-shell-function'
import { ClaudeProfileRouter, type ClaudeProfileRouterSettings } from './claude-profile-router'
import {
  claudeProfileHistoryDirs,
  getClaudeObservedConfigDirs,
  installClaudeObservedConfigDirs,
  installClaudeProfileRouter
} from './claude-profile-installed-router'
import { ClaudeObservedConfigDirs } from './claude-observed-config-dirs'
import { claudeRoutedHomeAsync } from './claude-profile-routed-home'

vi.mock('@orca/process-host', () => ({ runProcess: vi.fn() }))
const command = vi.hoisted(() => ({ path: '/unused-claude' }))
vi.mock('../codex-cli/command', () => ({ resolveClaudeCommand: () => command.path }))

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
  installClaudeObservedConfigDirs(undefined)
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
    const markSetUp = prepareClaudeProfileDirectory(dataRoot, profile, userHome)
    return new Promise<ClaudeProfileSetupReport>((resolve) => {
      setup.settle = () => {
        if (setup.outcome === 'prepared') {
          markSetUp()
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
    prepareClaudeProfileDirectory(
      f.dataRoot,
      describeClaudeProfile(f.dataRoot, 'a', {
        executionHostId: 'local',
        runtime: 'host'
      }),
      f.userHome
    )()
    signIn(f.userHome, 'A@Example.test')
    await expect(f.router.prepareLaunch()).resolves.toMatchObject({
      configDir: join(f.userHome, '.claude'),
      provenance: 'system'
    })
    expect(f.router.preparation().envPatch).not.toHaveProperty('CLAUDE_CONFIG_DIR')
    expect(f.router.terminalEnv()).toEqual({ ORCA_CLAUDE_PROFILE_POINTER: f.router.pointerPath })
    expect(f.router.routedHome()).toBeNull()
    expect(f.router.routedHome('identity')).toBeNull()
    await expect(claudeRoutedHomeAsync(f.router)).resolves.toBeNull()
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
    expect(f.router.routedHome()).toBe(f.home('a'))
    expect(f.router.routedHome('identity')).toBe(f.home('a'))
    await expect(claudeRoutedHomeAsync(f.router)).resolves.toBe(f.home('a'))
  })

  it('keeps an account on its own folder when System default is signed in to another email, or out', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const f = fixture()
    mkdirSync(f.home('a'), { recursive: true })
    prepareClaudeProfileDirectory(
      f.dataRoot,
      describeClaudeProfile(f.dataRoot, 'a', {
        executionHostId: 'local',
        runtime: 'host'
      }),
      f.userHome
    )()
    signIn(f.userHome, 'b@example.test')
    const anotherAccountLaunch = f.router.prepareLaunch()
    await advanceRefreshDeadline(anotherAccountLaunch, 500)
    await expect(anotherAccountLaunch).resolves.toMatchObject({ configDir: f.home('a') })
    writeFileSync(join(f.userHome, '.claude.json'), '{}')
    const signedOutLaunch = f.router.prepareLaunch()
    await advanceRefreshDeadline(signedOutLaunch, 500)
    await expect(signedOutLaunch).resolves.toMatchObject({ configDir: f.home('a') })
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
    const profile = describeClaudeProfile(f.dataRoot, 'a', {
      executionHostId: 'local',
      runtime: 'host'
    })
    prepareClaudeProfileDirectory(f.dataRoot, profile, f.userHome)()
    rmSync(profile.home, { recursive: true })
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
    expect(existsSync(profile.home)).toBe(true)
    expect(existsSync(claudeProfileMarkerPath(profile))).toBe(false)

    const launch = f.router.prepareLaunch()
    await vi.waitFor(() => expect(f.setup.calls).toBe(1))
    f.setup.settle()
    await expect(launch).resolves.toMatchObject({ configDir: f.home('a') })
    expect(JSON.parse(readFileSync(claudeProfileMarkerPath(profile), 'utf8'))).toEqual({
      version: 1,
      accountId: 'a',
      runtime: 'host'
    })
  })

  it("launches a set-up, signed-in account without waiting for the login shell's env", async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    shell.hang = true
    const f = fixture()
    mkdirSync(f.home('a'), { recursive: true })
    prepareClaudeProfileDirectory(
      f.dataRoot,
      describeClaudeProfile(f.dataRoot, 'a', {
        executionHostId: 'local',
        runtime: 'host'
      }),
      f.userHome
    )()
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

  it('requires concurrent launches to finish rebuilding a home whose marker survived', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const f = fixture()
    const profile = describeClaudeProfile(f.dataRoot, 'a', {
      executionHostId: 'local',
      runtime: 'host'
    })
    prepareClaudeProfileDirectory(f.dataRoot, profile, f.userHome)()
    rmSync(profile.home, { recursive: true })
    const launch = f.router.prepareLaunch()
    const failed = expect(launch).rejects.toMatchObject({ reason: 'claudeAccountSetupFailed' })
    await vi.advanceTimersByTimeAsync(0)
    expect(existsSync(profile.home)).toBe(true)
    expect(existsSync(claudeProfileMarkerPath(profile))).toBe(false)
    const joined = expect(f.router.prepareLaunch()).rejects.toMatchObject({
      reason: 'claudeAccountSetupFailed'
    })
    await vi.advanceTimersByTimeAsync(1_000)
    f.setup.outcome = 'refused'
    f.setup.settle()
    await Promise.all([failed, joined])

    f.setup.outcome = 'prepared'
    const retry = f.router.prepareLaunch()
    await vi.advanceTimersByTimeAsync(0)
    f.setup.settle()
    await expect(retry).resolves.toMatchObject({ configDir: f.home('a') })
    expect(JSON.parse(readFileSync(claudeProfileMarkerPath(profile), 'utf8'))).toEqual({
      version: 1,
      accountId: 'a',
      runtime: 'host'
    })
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

  // Creating real symlinks requires additional Windows privileges.

  it('lists history under a wrapper CLAUDE_CONFIG_DIR seen in a hook, after restart too', () => {
    const f = fixture()
    const projects = join(f.root, '.claude-work', 'projects')
    const file = join(f.root, 'observed.json')
    mkdirSync(join(projects, '-proj'), { recursive: true })
    const observe = () => new ClaudeObservedConfigDirs(file, () => ({}))
    installClaudeObservedConfigDirs(observe())
    expect(claudeProfileHistoryDirs('projects')).toEqual([])
    getClaudeObservedConfigDirs()?.observeTranscriptPath(join(projects, '-proj', 'id.jsonl'))
    installClaudeObservedConfigDirs(observe())
    expect(claudeProfileHistoryDirs('projects')).toEqual([projects])
  })
})
