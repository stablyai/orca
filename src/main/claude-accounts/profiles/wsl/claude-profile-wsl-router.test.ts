import type { BlockedWslDistro } from '../../../wsl/filesystem/wsl-unc-access-gate'
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
import type { ClaudeManagedAccount } from '../../../../shared/managed-account-types'
import type { WslSpec } from '../../../wsl/execution/wsl-runner'
import type * as WslPaths from '../../../../shared/wsl-paths'

const guest = vi.hoisted(
  (): { home: string; failure: { code: number; stdout: string } | null } => ({
    home: '',
    failure: null
  })
)
// Emulate the guest with local POSIX paths and /bin/sh.
vi.mock('../../../../shared/wsl-paths', async (original) => ({
  ...(await original<typeof WslPaths>()),
  toWindowsWslPath: (linuxPath: string) => linuxPath
}))
vi.mock('../../../wsl/discovery/distro-catalog', () => ({
  getWslHomeAsync: async (distro: string) => `\\\\wsl.localhost\\${distro}${guest.home}`,
  listRunningWslDistrosAsync: async () => ['Ubuntu']
}))
const gate = vi.hoisted(() => ({
  blocked: vi.fn(
    async (_path: string, _distro?: string | null): Promise<BlockedWslDistro | null> => null
  )
}))
vi.mock('../../../wsl/filesystem/wsl-unc-access-gate', () => ({
  blockedWslDistroForPath: gate.blocked
}))
vi.mock('../../../wsl/execution/wsl-runner', () => ({
  runWslProcess: async (spec: WslSpec) => {
    if (guest.failure) {
      return { ...guest.failure, stderr: '', timedOut: false }
    }
    // Real wsl.exe --exec refuses an empty argument before the guest runs.
    if (spec.args?.some((arg) => arg === '')) {
      return { code: 1, stdout: '', stderr: 'Wsl/Service/E_INVALIDARG', timedOut: false }
    }
    const result = spawnSync('/bin/sh', ['-c', spec.script ?? '', 'sh', ...(spec.args ?? [])], {
      encoding: 'utf8',
      input: spec.input
    })
    return { code: result.status, stdout: result.stdout, stderr: result.stderr, timedOut: false }
  }
}))

import type { ClaudeProfileRouterSettings } from '../routing/claude-profile-router'

import { ClaudeWslProfileRouter } from './claude-profile-wsl-router'

// Guest emulation runs POSIX scripts and the Linux Node bundle.
const posixHost = process.platform !== 'win32'
const roots: string[] = []
afterEach(() => {
  guest.failure = null
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }))
})

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

  it('launches on System default while a managed WSL account still exists', async () => {
    const f = fixture()
    mkdirSync(join(f.pointer, '..'), { recursive: true })
    writeFileSync(f.pointer, f.profileHome)
    f.wsl.Ubuntu = null
    await expect(f.router.prepareLaunch('Ubuntu')).resolves.toMatchObject({
      provenance: 'wsl:Ubuntu:system'
    })
    expect(readFileSync(f.pointer, 'utf8')).toBe('')
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
      entryPoints: [resolve('src/main/claude-accounts/profiles/wsl/claude-profile-wsl-entry.ts')],
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
