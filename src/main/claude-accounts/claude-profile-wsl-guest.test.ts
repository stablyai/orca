import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  realpathSync,
  readdirSync,
  symlinkSync
} from 'node:fs'
import { build } from 'esbuild'
import { runProcess, spawnProcess } from '../../shared/child-process/run-process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it, expect, afterEach } from 'vitest'
import { runClaudeWslProfileRequest } from './claude-profile-wsl-guest'
import { WSL_CLAUDE_PROFILE_POINTER_FROM_HOME } from '../../shared/claude-profile-routing'
import { describeClaudeProfile, prepareClaudeProfileDirectory } from './claude-profile-paths'
const roots: string[] = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))
function fixture(prefix = 'wsl-profile-') {
  const home = mkdtempSync(join(tmpdir(), prefix))
  roots.push(home)
  const data = join(home, '.local/share/orca')
  const profile = describeClaudeProfile(data, 'a', {
    executionHostId: 'local',
    runtime: 'wsl',
    distro: 'Ubuntu'
  })
  prepareClaudeProfileDirectory(data, profile, home)
  return {
    home,
    data,
    profile,
    request: { distro: 'Ubuntu', accountId: 'a', userHome: home, hooksEnabled: false }
  }
}
it('sets up in the fake guest home through the ownership gate, preserves login bytes and publishes the distro pointer', async () => {
  const f = fixture()
  mkdirSync(join(f.home, '.claude/projects'), { recursive: true })
  writeFileSync(join(f.home, '.claude/.credentials.json'), 'PERSONAL FAKE LOGIN')
  writeFileSync(join(f.profile.home, '.credentials.json'), 'PROFILE FAKE LOGIN')
  writeFileSync(
    join(f.profile.home, '.claude.json'),
    JSON.stringify({ oauthAccount: { sentinel: 'FAKE' } })
  )
  const result = await runClaudeWslProfileRequest({ ...f.request, action: 'setup' })
  expect(result.report?.outcome).toBe('prepared')
  expect(existsSync(join(f.profile.home, 'projects'))).toBe(true)
  expect(realpathSync(join(f.profile.home, 'projects'))).toBe(
    realpathSync(join(f.home, '.claude/projects'))
  )
  expect(readFileSync(join(f.profile.home, '.credentials.json'), 'utf8')).toBe('PROFILE FAKE LOGIN')
  expect(readFileSync(join(f.home, '.claude/.credentials.json'), 'utf8')).toBe(
    'PERSONAL FAKE LOGIN'
  )
  expect(
    JSON.parse(readFileSync(join(f.profile.home, '.claude.json'), 'utf8')).hasCompletedOnboarding
  ).toBe(true)
  await runClaudeWslProfileRequest({ ...f.request, action: 'publish' })
  expect(readFileSync(join(f.home, WSL_CLAUDE_PROFILE_POINTER_FROM_HOME), 'utf8')).toBe(
    f.profile.home
  )
  await runClaudeWslProfileRequest({ ...f.request, action: 'withdraw' })
  expect(existsSync(join(f.data, 'claude-profiles/selected-wsl'))).toBe(false)
})
it('refuses a different distro and never fabricates a login profile at launch', async () => {
  const f = fixture()
  await expect(
    runClaudeWslProfileRequest({ ...f.request, distro: 'Debian', action: 'setup' })
  ).rejects.toThrow('fresh sign-in')
  await expect(
    runClaudeWslProfileRequest({ ...f.request, accountId: 'missing', action: 'publish' })
  ).rejects.toThrow('fresh sign-in')
  expect(existsSync(join(f.data, 'claude-profiles/missing'))).toBe(false)
})

it('runs the bundled helper directly with explicit fake homes and keeps hook writes out of the process home', async () => {
  const f = fixture()
  const sentinel = join(f.home, 'sentinel')
  mkdirSync(sentinel)
  const bundle = join(f.home, 'guest.cjs')
  await build({
    entryPoints: ['src/main/claude-accounts/claude-profile-wsl-entry.ts'],
    outfile: bundle,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
    logLevel: 'silent'
  })
  const result = await runProcess({
    program: process.execPath,
    args: [bundle],
    input: JSON.stringify({
      ...f.request,
      action: 'setup',
      hooksEnabled: true,
      claudeVersion: '2.1.261'
    }),
    env: {
      HOME: sentinel,
      USERPROFILE: sentinel,
      PATH: '/usr/bin:/bin',
      ORCA_BACKGROUND_LAUNCH: '1'
    },
    timeoutMs: 20_000
  })
  expect(result.code, result.stderr).toBe(0)
  expect(JSON.parse(result.stdout).report.surfaces.hooks).toBe('merged')
  expect(existsSync(join(f.home, '.orca/agent-hooks/claude-hook.sh'))).toBe(true)
  expect(readdirSync(sentinel)).toEqual([])
})
it('pre-trusts only the guest workspace through the guarded writer, preserving private state', async () => {
  const f = fixture()
  const file = join(f.profile.home, '.claude.json')
  writeFileSync(file, JSON.stringify({ oauthAccount: { sentinel: 'FAKE' } }))
  const workspace = join(f.home, 'workspace')
  mkdirSync(workspace)
  await runClaudeWslProfileRequest({ ...f.request, action: 'trust', workspacePath: workspace })
  const state = JSON.parse(readFileSync(file, 'utf8'))
  expect(state.oauthAccount).toEqual({ sentinel: 'FAKE' })
  expect(state.projects[workspace].hasTrustDialogAccepted).toBe(true)
  await runClaudeWslProfileRequest({ ...f.request, action: 'trust', workspacePath: f.home })
  expect(JSON.parse(readFileSync(file, 'utf8')).projects[f.home]).toBeUndefined()
})

it('distinguishes unreadable ownership from an absent account before any provisioning', async () => {
  const f = fixture()
  writeFileSync(join(f.data, 'claude-profiles/a/profile.json'), '{malformed')
  await expect(runClaudeWslProfileRequest({ ...f.request, action: 'setup' })).rejects.toThrow(
    'ownership is unreadable'
  )
  expect(existsSync(join(f.profile.home, 'projects'))).toBe(false)
})

it('deduplicates shared guest history and rejects an arbitrary linked history root', async () => {
  const f = fixture()
  await runClaudeWslProfileRequest({ ...f.request, action: 'setup' })
  const shared = await runClaudeWslProfileRequest({ ...f.request, action: 'inspect' })
  expect(shared.historyHomes?.projects).toEqual([realpathSync(join(f.home, '.claude'))])
  rmSync(join(f.profile.home, 'projects'))
  const outside = join(f.home, 'outside')
  mkdirSync(outside)
  symlinkSync(outside, join(f.profile.home, 'projects'))
  const inspected = await runClaudeWslProfileRequest({ ...f.request, action: 'inspect' })
  expect(inspected.historyHomes?.projects).toEqual([realpathSync(join(f.home, '.claude'))])
})
it('reads a request whose UTF-8 home is split across stdin chunks', async () => {
  const f = fixture('wsl-profile-\u00fc-')
  const bundle = join(f.home, 'guest.cjs')
  await build({
    entryPoints: ['src/main/claude-accounts/claude-profile-wsl-entry.ts'],
    outfile: bundle,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
    logLevel: 'silent'
  })
  const child = spawnProcess({
    program: process.execPath,
    args: [bundle],
    env: { HOME: f.home, PATH: '/usr/bin:/bin', ORCA_BACKGROUND_LAUNCH: '1' }
  })
  let stdout = ''
  child.stdout.on('data', (chunk) => (stdout += chunk))
  const exited = new Promise((resolve) => child.on('close', resolve))
  const payload = Buffer.from(JSON.stringify({ ...f.request, action: 'inspect' }))
  const split = payload.indexOf(Buffer.from('\u00fc')) + 1
  child.stdin.write(payload.subarray(0, split))
  await new Promise((resolve) => setTimeout(resolve, 50))
  child.stdin.end(payload.subarray(split))
  expect(await exited).toBe(0)
  expect(JSON.parse(stdout)).toMatchObject({ ready: true })
  expect(JSON.parse(stdout).homes).toContain(f.profile.home)
})
