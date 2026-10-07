import { spawnSync } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
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
// The guest is this machine: its "UNC" paths are the Linux paths, and scripts run in /bin/sh.
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
  CLAUDE_PROFILE_SETUP_FAILED_MESSAGE,
  type ClaudeProfileRouterSettings
} from './claude-profile-router'
import { ClaudeWslProfileRouter } from './claude-profile-wsl-router'

// Why skipped on Windows: the guest is Linux; these run its scripts and Node bundle as the guest.
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
      writeFileSync(join(profileHome, '..', 'profile.json'), '{}')
    }
  })
  const profileHome = join(guest.home, '.local/share/orca/claude-profiles/a/home')
  const pointer = join(guest.home, '.local/share/orca/claude-profiles/selected-wsl-orca-dev')
  return { settings, wsl, setup, router, profileHome, pointer, account }
}

describe.skipIf(!posixHost)('ClaudeWslProfileRouter', () => {
  it('writes the guest pointer per build, sets up only a signed-in folder, and removes it with the last account', async () => {
    const f = fixture()
    await f.router.publish('Ubuntu')
    expect(readFileSync(f.pointer, 'utf8')).toBe(f.profileHome)
    expect(f.setup.calls).toBe(0)

    mkdirSync(f.profileHome, { recursive: true })
    await f.router.publish('Ubuntu')
    await vi.waitFor(() => expect(f.setup.calls).toBe(1))

    f.wsl.Ubuntu = null
    await f.router.publish('Ubuntu')
    expect(readFileSync(f.pointer, 'utf8')).toBe('')

    f.settings.claudeManagedAccounts = []
    await f.router.publish('Ubuntu')
    expect(existsSync(f.pointer)).toBe(false)
  })

  it('refuses a missing folder, waits for a never-set-up one, then launches at once', async () => {
    const f = fixture()
    await expect(f.router.prepareLaunch('Ubuntu')).rejects.toThrow(CLAUDE_PROFILE_MISSING_MESSAGE)

    mkdirSync(f.profileHome, { recursive: true })
    f.setup.fail = true
    await expect(f.router.prepareLaunch('Ubuntu')).rejects.toThrow(
      CLAUDE_PROFILE_SETUP_FAILED_MESSAGE
    )
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
    await f.router.prepareLaunch('Ubuntu')
    expect(f.setup.calls).toBe(2)
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
    const run = (accountId: string) =>
      spawnSync(process.execPath, [helper, home, 'Ubuntu', accountId], { encoding: 'utf8' })

    expect(run('a').status).toBe(0)
    expect(existsSync(join(profileHome, '..', 'profile.json'))).toBe(true)
    // History is a Linux link into the guest's own ~/.claude.
    expect(lstatSync(join(profileHome, 'projects')).isSymbolicLink()).toBe(true)
    expect(run('../escape').status).not.toBe(0)
  }
)
