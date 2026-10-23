import { spawnSync } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ClaudeManagedAccount } from '../../shared/managed-account-types'
import type { WslSpec } from '../wsl/wsl-runner'
import type * as WslPaths from '../../shared/wsl-paths'

const guest = vi.hoisted(() => ({ home: '' }))
// Emulate the guest with local POSIX paths and /bin/sh.
vi.mock('../../shared/wsl-paths', async (original) => ({
  ...(await original<typeof WslPaths>()),
  toWindowsWslPath: (linuxPath: string) => linuxPath
}))
vi.mock('../wsl', () => ({
  getWslHomeAsync: async (distro: string) => `\\\\wsl.localhost\\${distro}${guest.home}`,
  listRunningWslDistrosAsync: async () => ['Ubuntu']
}))
vi.mock('../wsl/wsl-runner', () => ({
  runWslProcess: async (spec: WslSpec) => {
    const result = spawnSync('/bin/sh', ['-c', spec.script ?? '', 'sh', ...(spec.args ?? [])], {
      encoding: 'utf8'
    })
    return { code: result.status, stdout: result.stdout, stderr: result.stderr, timedOut: false }
  }
}))

import {
  CLAUDE_PROFILE_MISSING_MESSAGE,
  CLAUDE_PROFILE_SETUP_FAILED_MESSAGE
} from '../../shared/claude-profile-routing'
import type { ClaudeProfileRouterSettings } from './claude-profile-router'
import { prepareClaudeProfileDirectory } from './claude-profile-paths'
import { ClaudeWslProfileRouter } from './claude-profile-wsl-router'
import { applyClaudeEnvPatch } from './environment'
import { wslClaudeProfile } from './claude-profile-wsl-paths'

// Guest emulation runs POSIX scripts and the Linux Node bundle.
const posixHost = process.platform !== 'win32'
const roots: string[] = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'claude-wsl-router-'))
  roots.push(root)
  guest.home = join(root, 'home')
  mkdirSync(join(guest.home, '.claude'), { recursive: true })
  const account = (id: string): ClaudeManagedAccount => ({
    id,
    email: `${id}@example.test`,
    authMethod: 'subscription-oauth',
    managedAuthPath: '/unused-legacy',
    managedAuthRuntime: 'wsl',
    wslDistro: 'Ubuntu',
    createdAt: 0,
    updatedAt: 0,
    lastAuthenticatedAt: 0
  })
  const wsl: Record<string, string | null> = { Ubuntu: 'a' }
  const settings: ClaudeProfileRouterSettings = {
    claudeManagedAccounts: [account('a')],
    activeClaudeManagedAccountId: null,
    activeClaudeManagedAccountIdsByRuntime: { host: null, wsl },
    agentStatusHooksEnabled: false,
    disabledTuiAgents: []
  }
  const setup = { calls: 0, fail: false, gate: Promise.resolve() }
  const router = new ClaudeWslProfileRouter({
    getSettings: () => settings,
    dataRoot: join(root, 'orca-dev'),
    runSetup: async () => {
      setup.calls += 1
      await setup.gate
      if (setup.fail) {
        throw new Error('refused')
      }
      mkdirSync(profileHome, { recursive: true })
      writeFileSync(join(profileHome, '..', 'profile.json'), '{}')
    }
  })
  const profileHome = join(guest.home, '.local/share/orca/claude-profiles/a/home')
  const pointer = join(guest.home, '.local/share/orca/claude-profiles/selected-wsl-orca-dev')
  return { settings, wsl, setup, router, profileHome, pointer, account }
}

describe.skipIf(!posixHost)('ClaudeWslProfileRouter', () => {
  it('publishes and launches the saved account across distro casing without changing guest spelling', async () => {
    const f = fixture()
    await f.router.publish('ubuntu')
    expect(readFileSync(f.pointer, 'utf8')).toBe(f.profileHome)
    const launch = await f.router.prepareLaunch('ubuntu')
    expect(launch).toMatchObject({
      wslDistro: 'ubuntu',
      envPatch: { CLAUDE_CONFIG_DIR: f.profileHome }
    })
    f.settings.claudeManagedAccounts[0].wslDistro = 'ubuntu'
    expect(await f.router.runningDistros()).toEqual(['Ubuntu'])
    expect((await f.router.preparation('Ubuntu')).envPatch.CLAUDE_CONFIG_DIR).toBe(f.profileHome)
  })

  it('writes the guest pointer per build, sets up even a missing folder, and removes it with the last account', async () => {
    const f = fixture()
    await f.router.publish('Ubuntu')
    expect(readFileSync(f.pointer, 'utf8')).toBe(f.profileHome)
    await vi.waitFor(() => expect(f.setup.calls).toBe(1))

    f.wsl.Ubuntu = null
    await f.router.publish('Ubuntu')
    expect(readFileSync(f.pointer, 'utf8')).toBe('')

    f.settings.claudeManagedAccounts = []
    await f.router.publish('Ubuntu')
    expect(existsSync(f.pointer)).toBe(false)
  })

  it('sets up a missing folder, waits for a first setup never run or still running, then launches at once', async () => {
    const f = fixture()
    await expect(f.router.preparation('Ubuntu')).rejects.toThrow(CLAUDE_PROFILE_MISSING_MESSAGE)
    f.setup.fail = true
    let release = () => {}
    f.setup.gate = new Promise((resolve) => (release = resolve))
    const launch = f.router.prepareLaunch('Ubuntu')
    await vi.waitFor(() => expect(f.setup.calls).toBe(1))
    const second = f.router.prepareLaunch('Ubuntu')
    await new Promise((resolve) => setTimeout(resolve, 50))
    release()
    await expect(launch).rejects.toThrow(CLAUDE_PROFILE_SETUP_FAILED_MESSAGE)
    await expect(second).rejects.toThrow(CLAUDE_PROFILE_SETUP_FAILED_MESSAGE)
    expect(f.setup.calls).toBe(1)

    f.setup.fail = false
    const prepared = await f.router.prepareLaunch('Ubuntu')
    expect(prepared).toMatchObject({
      configDir: f.profileHome,
      runtime: 'wsl',
      wslDistro: 'Ubuntu',
      wslLinuxConfigDir: f.profileHome,
      envPatch: {
        ORCA_CLAUDE_PROFILE_POINTER: '~/.local/share/orca/claude-profiles/selected-wsl-orca-dev',
        CLAUDE_CONFIG_DIR: f.profileHome,
        ORCA_CLAUDE_INJECTED_CONFIG_DIR: f.profileHome
      }
    })
    expect(f.setup.calls).toBe(2)
    f.setup.gate = new Promise(() => {})
    await f.router.prepareLaunch('Ubuntu')
    expect(f.setup.calls).toBe(3)
  })

  it('reads usage from the same guest folder a launch (local or WSL-host) runs in', async () => {
    const f = fixture()
    const launch = await f.router.prepareLaunch('Ubuntu')
    const usage = await f.router.accountUsagePreparation('Ubuntu', 'a')
    const poll = await f.router.preparation('Ubuntu')
    expect(usage.wslLinuxConfigDir).toBe(launch.envPatch.CLAUDE_CONFIG_DIR)
    expect(poll.wslLinuxConfigDir).toBe(launch.envPatch.CLAUDE_CONFIG_DIR)
  })

  it('makes a launch redo a first setup that was cut off after its ownership gate', async () => {
    const f = fixture()
    mkdirSync(f.profileHome, { recursive: true })
    const cutOff = new ClaudeWslProfileRouter({
      getSettings: () => f.settings,
      dataRoot: join(guest.home, '..', 'orca-dev'),
      runSetup: async (distro, home, accountId) => {
        const { dataRoot, profile } = wslClaudeProfile(home, distro, accountId)
        prepareClaudeProfileDirectory(dataRoot, profile, home)
        throw new Error('timed out')
      }
    })
    await expect(cutOff.prepareLaunch('Ubuntu')).rejects.toThrow(
      CLAUDE_PROFILE_SETUP_FAILED_MESSAGE
    )
    expect(existsSync(join(f.profileHome, '..', 'profile.json'))).toBe(false)

    await f.router.prepareLaunch('Ubuntu')
    expect(f.setup.calls).toBe(1)
  })

  it('never makes a launch wait on, or fail with, a re-run of a set-up folder', async () => {
    const f = fixture()
    mkdirSync(f.profileHome, { recursive: true })
    writeFileSync(join(f.profileHome, '..', 'profile.json'), '{}')
    f.setup.fail = true
    let release = () => {}
    f.setup.gate = new Promise((resolve) => (release = resolve))
    await f.router.publish('Ubuntu')
    await vi.waitFor(() => expect(f.setup.calls).toBe(1))
    await expect(f.router.prepareLaunch('Ubuntu')).resolves.toMatchObject({
      configDir: f.profileHome
    })
    release()
    await new Promise((resolve) => setTimeout(resolve, 10))
    await expect(f.router.prepareLaunch('Ubuntu')).resolves.toMatchObject({
      configDir: f.profileHome
    })
    expect(f.setup.calls).toBe(2)
  })

  it('sets up a new account folder for sign-in and deletes it without following its links', async () => {
    const f = fixture()
    const sharedHistory = join(guest.home, '.claude', 'projects')
    mkdirSync(sharedHistory)
    writeFileSync(join(sharedHistory, 'chat.jsonl'), '{}')
    // The setup stub always writes account a's folder, even when preparing b.
    mkdirSync(f.profileHome, { recursive: true })
    const home = await f.router.prepareAccount('Ubuntu', 'b')
    expect(home).toBe(join(guest.home, '.local/share/orca/claude-profiles/b/home'))
    expect(f.setup.calls).toBe(1)
    mkdirSync(home, { recursive: true })
    symlinkSync(sharedHistory, join(home, 'projects'))

    await f.router.removeAccount('Ubuntu', 'b')
    expect(existsSync(join(home, '..'))).toBe(false)
    expect(existsSync(join(sharedHistory, 'chat.jsonl'))).toBe(true)

    f.setup.fail = true
    await expect(f.router.prepareAccount('Ubuntu', 'c')).rejects.toThrow(
      CLAUDE_PROFILE_SETUP_FAILED_MESSAGE
    )
  })

  it('removes a guest folder only after its running setup, so the setup cannot bring it back', async () => {
    const f = fixture()
    mkdirSync(f.profileHome, { recursive: true })
    let release = () => {}
    f.setup.gate = new Promise<void>((resolve) => (release = resolve)).then(() => {
      mkdirSync(f.profileHome, { recursive: true })
    })
    await f.router.publish('Ubuntu')
    await vi.waitFor(() => expect(f.setup.calls).toBe(1))
    const removal = f.router.removeAccount('Ubuntu', 'a')
    await new Promise((resolve) => setTimeout(resolve, 50))
    release()
    await removal
    expect(existsSync(join(f.profileHome, '..'))).toBe(false)
  })

  it('writes a missing guest pointer before a launch returns', async () => {
    const f = fixture()
    mkdirSync(f.profileHome, { recursive: true })
    writeFileSync(join(f.profileHome, '..', 'profile.json'), '{}')
    expect(existsSync(f.pointer)).toBe(false)
    await f.router.prepareLaunch('Ubuntu')
    expect(readFileSync(f.pointer, 'utf8')).toBe(f.profileHome)
  })

  it('a launch waiting on setup leaves a selection made meanwhile in the pointer', async () => {
    const f = fixture()
    mkdirSync(f.profileHome, { recursive: true })
    let release = () => {}
    f.setup.gate = new Promise((resolve) => (release = resolve))
    const launch = f.router.prepareLaunch('Ubuntu')
    await vi.waitFor(() => expect(f.setup.calls).toBe(1))

    f.settings.claudeManagedAccounts = [f.account('a'), f.account('b')]
    f.wsl.Ubuntu = 'b'
    await f.router.publish('Ubuntu')
    const homeB = join(f.profileHome, '../../b/home')
    expect(readFileSync(f.pointer, 'utf8')).toBe(homeB)
    release()
    await launch
    expect(readFileSync(f.pointer, 'utf8')).toBe(homeB)
  })

  it('overwrites a guest pointer that names another account before a launch returns', async () => {
    const f = fixture()
    mkdirSync(f.profileHome, { recursive: true })
    writeFileSync(join(f.profileHome, '..', 'profile.json'), '{}')
    mkdirSync(join(f.pointer, '..'), { recursive: true })
    writeFileSync(f.pointer, join(f.profileHome, '../../b/home'))
    await f.router.prepareLaunch('Ubuntu')
    expect(readFileSync(f.pointer, 'utf8')).toBe(f.profileHome)
  })

  it("runs an account with no login of its own on the guest's ~/.claude while that is signed in to it", async () => {
    const f = fixture()
    mkdirSync(f.profileHome, { recursive: true })
    writeFileSync(join(f.profileHome, '..', 'profile.json'), '{}')
    const login = (dir: string, email: string) =>
      writeFileSync(
        join(dir, '.claude.json'),
        JSON.stringify({ oauthAccount: { emailAddress: email } })
      )
    login(guest.home, 'A@example.test')
    await expect(f.router.prepareLaunch('Ubuntu')).resolves.toMatchObject({
      wslLinuxConfigDir: join(guest.home, '.claude'),
      provenance: 'wsl:Ubuntu:system'
    })
    expect(readFileSync(f.pointer, 'utf8')).toBe('')
    await f.router.publish('Ubuntu')
    expect(readFileSync(f.pointer, 'utf8')).toBe('')

    login(f.profileHome, 'a@example.test')
    await expect(f.router.prepareLaunch('Ubuntu')).resolves.toMatchObject({
      wslLinuxConfigDir: f.profileHome
    })
    expect(readFileSync(f.pointer, 'utf8')).toBe(f.profileHome)

    rmSync(join(f.profileHome, '.claude.json'))
    f.settings.claudeManagedAccounts = [{ ...f.account('a'), organizationUuid: 'org-a' }]
    writeFileSync(
      join(guest.home, '.claude.json'),
      JSON.stringify({
        oauthAccount: { emailAddress: 'a@example.test', organizationUuid: 'org-b' }
      })
    )
    await expect(f.router.prepareLaunch('Ubuntu')).resolves.toMatchObject({
      wslLinuxConfigDir: f.profileHome
    })
    login(guest.home, 'b@example.test')
    await expect(f.router.prepareLaunch('Ubuntu')).resolves.toMatchObject({
      wslLinuxConfigDir: f.profileHome
    })
  })

  it("keeps a shell proxy's key with its address on WSL launches, account or System default", async () => {
    const f = fixture()
    mkdirSync(f.profileHome, { recursive: true })
    writeFileSync(join(f.profileHome, '..', 'profile.json'), '{}')
    const shell = { ANTHROPIC_BASE_URL: 'https://proxy.example.test', ANTHROPIC_API_KEY: 'k' }
    for (const selected of ['a', null]) {
      f.wsl.Ubuntu = selected
      const prepared = await f.router.prepareLaunch('Ubuntu')
      expect(applyClaudeEnvPatch({ ...shell }, prepared.envPatch)).toMatchObject(shell)
    }
  })

  it('launches System default from the guest ~/.claude with no account env', async () => {
    const f = fixture()
    f.wsl.Ubuntu = null
    const prepared = await f.router.preparation('Ubuntu')
    expect(prepared.wslLinuxConfigDir).toBe(join(guest.home, '.claude'))
    expect(prepared.envPatch).toEqual({
      ORCA_CLAUDE_PROFILE_POINTER: '~/.local/share/orca/claude-profiles/selected-wsl-orca-dev'
    })
    expect(await f.router.runningDistros()).toEqual(['Ubuntu'])
  })
})

it.skipIf(!posixHost)(
  'the guest helper runs Step 1 setup as a standalone Linux Node bundle',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'claude-wsl-helper-'))
    roots.push(root)
    const home = join(root, 'home')
    mkdirSync(join(home, '.claude', 'projects'), { recursive: true })
    const profileHome = join(home, '.local/share/orca/claude-profiles/a/home')
    mkdirSync(profileHome, { recursive: true })
    const helper = join(root, 'claude-profile-wsl.cjs')
    await build({
      entryPoints: [resolve('src/main/claude-accounts/claude-profile-wsl-entry.ts')],
      outfile: helper,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      external: ['electron'],
      logLevel: 'silent'
    })
    const run = (accountId: string, distro = 'Ubuntu') =>
      spawnSync(process.execPath, [helper, home, distro, accountId], { encoding: 'utf8' })

    expect(run('a').status).toBe(0)
    expect(existsSync(join(profileHome, '..', 'profile.json'))).toBe(true)
    expect(lstatSync(join(profileHome, 'projects')).isSymbolicLink()).toBe(true)
    const marker = readFileSync(join(profileHome, '..', 'profile.json'), 'utf8')
    expect(run('a', 'ubuntu').status).toBe(0)
    expect(readFileSync(join(profileHome, '..', 'profile.json'), 'utf8')).toBe(marker)
    expect(run('a', 'Debian').status).not.toBe(0)
    expect(run('../escape').status).not.toBe(0)
  }
)
