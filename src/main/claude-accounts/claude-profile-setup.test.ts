import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import type * as Os from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({ home: '' }))
vi.mock('node:os', async (original) => ({
  ...(await original<typeof Os>()),
  homedir: () => state.home
}))
vi.mock('electron', () => ({ app: { getPath: () => state.home } }))
import { ClaudeHookService } from '../claude/hook-service'
import { describeClaudeProfile } from './claude-profile-paths'
import { provisionClaudeAccountProfile } from './claude-profile-setup'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})
const local = { runtime: 'host', executionHostId: 'local' } as const
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'claude-profile-setup-')))
  roots.push(root)
  state.home = join(root, 'home')
  const defaultHome = join(state.home, '.claude')
  const dataRoot = join(root, 'data')
  mkdirSync(defaultHome, { recursive: true })
  mkdirSync(dataRoot)
  const service = new ClaudeHookService()
  const installHooks = (target: { configDir: string }) =>
    service.install({ claudeVersion: '2.1.261', ...target })
  const setup = () =>
    provisionClaudeAccountProfile({
      dataRoot,
      profile: describeClaudeProfile(dataRoot, 'a', local),
      userHome: state.home,
      installHooks,
      platform: 'linux'
    })
  return { root, defaultHome, dataRoot, service, installHooks, setup }
}

// Why: setup runs as 'linux', so it creates real symlinks, which Windows needs privilege for.
const itLinks = it.skipIf(process.platform === 'win32')

describe('Claude account profile setup', () => {
  itLinks('prepares, shares history, provisions and installs hooks in one call', async () => {
    const f = fixture()
    mkdirSync(join(f.defaultHome, 'skills'))
    writeFileSync(join(f.defaultHome, 'settings.json'), '{"model":"opus"}')
    f.service.install({ claudeVersion: '2.1.261' })
    const report = await f.setup()
    const home = join(f.dataRoot, 'claude-profiles/a/home')
    expect(report).toMatchObject({ outcome: 'prepared', warnings: [] })
    expect(report.surfaces).toMatchObject({
      projects: 'linked',
      'history.jsonl': 'linked',
      skills: 'linked',
      'settings.json': 'merged',
      '.claude.json': 'absent',
      hooks: 'merged'
    })
    expect(existsSync(join(f.dataRoot, 'claude-profiles/a/profile.json'))).toBe(true)
    const settings = JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8'))
    const defaults = JSON.parse(readFileSync(join(f.defaultHome, 'settings.json'), 'utf8'))
    expect(settings).toEqual({
      model: 'opus',
      hooks: defaults.hooks,
      statusLine: defaults.statusLine
    })
    expect(realpathSync(join(home, 'projects'))).toBe(realpathSync(join(f.defaultHome, 'projects')))
    expect(existsSync(join(home, '.credentials.json'))).toBe(false)
    expect((await f.setup()).warnings).toEqual([])
  })
  itLinks('marks the folder set up only after its last step', async () => {
    const f = fixture()
    const marker = join(f.dataRoot, 'claude-profiles/a/profile.json')
    let markedDuringHooks: boolean | undefined
    const report = await provisionClaudeAccountProfile({
      dataRoot: f.dataRoot,
      profile: describeClaudeProfile(f.dataRoot, 'a', local),
      userHome: state.home,
      installHooks: (target) => {
        markedDuringHooks = existsSync(marker)
        return f.installHooks(target)
      },
      platform: 'linux'
    })
    expect(report.outcome).toBe('prepared')
    expect(markedDuringHooks).toBe(false)
    expect(existsSync(marker)).toBe(true)
  })
  itLinks("brings the user's later hooks into an account set up while they had none", async () => {
    const f = fixture()
    const settings = join(f.defaultHome, 'settings.json')
    writeFileSync(settings, '{"model":"opus"}')
    await f.setup()
    const home = join(f.dataRoot, 'claude-profiles/a/home')
    const read = (file: string) => JSON.parse(readFileSync(file, 'utf8'))
    const orca = read(join(home, 'settings.json')).hooks
    expect(orca).toBeDefined()
    const mine = { matcher: '', hooks: [{ type: 'command', command: 'notify-me' }] }
    writeFileSync(settings, JSON.stringify({ model: 'opus', hooks: { Notification: [mine] } }))
    expect((await f.setup()).warnings).toEqual([])
    const hooks = read(join(home, 'settings.json')).hooks
    expect(hooks.Notification).toContainEqual(mine)
    expect(hooks.Stop).toEqual(orca.Stop)
  })
  itLinks('refuses another account in the same slot without creating anything', async () => {
    const f = fixture()
    await f.setup()
    writeFileSync(
      join(f.dataRoot, 'claude-profiles/a/profile.json'),
      JSON.stringify({ version: 1, accountId: 'b', runtime: 'host' })
    )
    rmSync(join(f.dataRoot, 'claude-profiles/a/home'), { recursive: true })
    const report = await f.setup()
    expect(report.outcome).toBe('refused')
    expect(report.warnings).toEqual([
      expect.objectContaining({ surface: 'profile', code: 'invalid-profile' })
    ])
    expect(existsSync(join(f.dataRoot, 'claude-profiles/a/home'))).toBe(false)
  })
  itLinks('refuses a data root linked into the default home before writing there', async () => {
    const f = fixture()
    mkdirSync(join(f.defaultHome, 'inner'))
    symlinkSync(join(f.defaultHome, 'inner'), join(f.dataRoot, 'claude-profiles'))
    expect((await f.setup()).outcome).toBe('refused')
    expect(existsSync(join(f.defaultHome, 'inner', 'a'))).toBe(false)
  })
  it('refuses a WSL profile on the Windows host side', async () => {
    fixture()
    const report = await provisionClaudeAccountProfile({
      dataRoot: '/home/u/.local/share/orca',
      profile: describeClaudeProfile('/home/u/.local/share/orca', 'a', {
        runtime: 'wsl',
        distro: 'Ubuntu',
        executionHostId: 'local'
      }),
      userHome: state.home,
      installHooks: null,
      platform: 'win32'
    })
    expect(report.outcome).toBe('refused')
    expect(report.warnings).toEqual([
      expect.objectContaining({ surface: 'profile', code: 'invalid-profile' })
    ])
  })
  itLinks('reports skipped and failed hook installs without failing the rest', async () => {
    const f = fixture()
    const skipped = await provisionClaudeAccountProfile({
      dataRoot: f.dataRoot,
      profile: describeClaudeProfile(f.dataRoot, 'a', local),
      userHome: state.home,
      installHooks: null,
      platform: 'linux'
    })
    expect(skipped.surfaces.hooks).toBe('absent')
    writeFileSync(join(f.dataRoot, 'claude-profiles/a/home/settings.json'), '{bad')
    const failed = await f.setup()
    expect(failed.surfaces.hooks).toBe('failed')
    expect(failed.surfaces.projects).toBe('unchanged')
    expect(failed.warnings).toContainEqual(
      expect.objectContaining({ surface: 'hooks', code: 'failed' })
    )
  })
})
