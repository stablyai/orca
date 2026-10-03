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
  const installHooks = (target: { configDir: string; userHome: string }) =>
    service.install({ claudeVersion: '2.1.261', ...target })
  const setup = () =>
    provisionClaudeAccountProfile({
      dataRoot,
      profile: describeClaudeProfile(dataRoot, 'a', local),
      userHome: state.home,
      installHooks
    })
  return { root, defaultHome, dataRoot, service, setup }
}

describe('Claude account profile setup', () => {
  it('prepares, shares history, provisions and installs hooks in one call', async () => {
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
  it('follows the userHome it was given for the profile statusline, not the process home', async () => {
    const f = fixture()
    f.service.install({ claudeVersion: '2.1.261' })
    const userHome = state.home
    state.home = join(f.root, 'process-home')
    mkdirSync(state.home)
    const report = await provisionClaudeAccountProfile({
      dataRoot: f.dataRoot,
      profile: describeClaudeProfile(f.dataRoot, 'a', local),
      userHome,
      installHooks: (target) => f.service.install({ claudeVersion: '2.1.261', ...target })
    })
    expect(report.surfaces.hooks).toBe('merged')
    const settings = JSON.parse(
      readFileSync(join(f.dataRoot, 'claude-profiles/a/home/settings.json'), 'utf8')
    )
    expect(settings.statusLine).toEqual(
      JSON.parse(readFileSync(join(f.defaultHome, 'settings.json'), 'utf8')).statusLine
    )
  })
  it('refuses another account in the same slot without creating anything', async () => {
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
  it('refuses a data root linked into the default home before writing there', async () => {
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
  it('reports skipped and failed hook installs without failing the rest', async () => {
    const f = fixture()
    const skipped = await provisionClaudeAccountProfile({
      dataRoot: f.dataRoot,
      profile: describeClaudeProfile(f.dataRoot, 'a', local),
      userHome: state.home,
      installHooks: null
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
