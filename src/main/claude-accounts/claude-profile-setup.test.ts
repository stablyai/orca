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
import { parseClaudeCliVersionOutput } from '../claude/claude-hook-event-versions'
import { ClaudeHookService } from '../claude/hook-service'
import { describeClaudeProfile, prepareClaudeProfileDirectory } from './claude-profile-paths'
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

// Linux-mode setup creates symlinks that require additional privileges on Windows.
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
      'settings.json': 'synced',
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
    const unknown = parseClaudeCliVersionOutput('11.17.0') ?? undefined
    const refreshed = await provisionClaudeAccountProfile({
      dataRoot: f.dataRoot,
      profile: describeClaudeProfile(f.dataRoot, 'a', local),
      userHome: state.home,
      installHooks: (target) => f.service.install({ ...target, claudeVersion: unknown }),
      platform: 'linux'
    })
    expect(refreshed.warnings).toEqual([])
    expect(JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8'))).toEqual(settings)
    expect((await f.setup()).warnings).toEqual([])
  })
  itLinks('shares plugins Claude wrote into the folder before its first setup', async () => {
    const f = fixture()
    mkdirSync(join(f.defaultHome, 'plugins'))
    writeFileSync(join(f.defaultHome, 'plugins', 'installed_plugins.json'), '{"mine":true}')
    const home = join(f.dataRoot, 'claude-profiles/a/home')
    // A pane's `claude` read the pointer before setup ran and made its own registry.
    mkdirSync(join(home, 'plugins'), { recursive: true })
    writeFileSync(join(home, 'plugins', 'installed_plugins.json'), '{"version":2,"plugins":{}}')
    writeFileSync(join(home, 'plugins', 'claude-only.json'), '{}')
    const report = await f.setup()
    expect(report.surfaces.plugins).toBe('linked')
    expect(realpathSync(join(home, 'plugins'))).toBe(realpathSync(join(f.defaultHome, 'plugins')))
    expect(readFileSync(join(f.defaultHome, 'plugins', 'installed_plugins.json'), 'utf8')).toBe(
      '{"mine":true}'
    )
    expect(existsSync(join(f.defaultHome, 'plugins', 'claude-only.json'))).toBe(true)
    expect(report.warnings).toContainEqual(
      expect.objectContaining({ surface: 'plugins', code: 'retained-conflict' })
    )
    // After setup, a folder the user put in place of the link stays theirs.
    rmSync(join(home, 'plugins'))
    mkdirSync(join(home, 'plugins'))
    writeFileSync(join(home, 'plugins', 'own.json'), '{}')
    expect((await f.setup()).surfaces.plugins).toBe('user-owned')
  })
  itLinks('rebuilds a missing home without marking it set up before its last step', async () => {
    const f = fixture()
    const profile = describeClaudeProfile(f.dataRoot, 'a', local)
    const marker = join(f.dataRoot, 'claude-profiles/a/profile.json')
    prepareClaudeProfileDirectory(f.dataRoot, profile, state.home)()
    rmSync(profile.home, { recursive: true })
    mkdirSync(join(f.defaultHome, 'plugins'))
    let markedDuringHooks: boolean | undefined
    const pending = provisionClaudeAccountProfile({
      dataRoot: f.dataRoot,
      profile: describeClaudeProfile(f.dataRoot, 'a', local),
      userHome: state.home,
      installHooks: (target) => {
        markedDuringHooks = existsSync(marker)
        return f.installHooks(target)
      },
      platform: 'linux'
    })
    // A running Claude may create its registry while history sharing is finishing.
    mkdirSync(join(profile.home, 'plugins'))
    writeFileSync(join(profile.home, 'plugins', 'claude-only.json'), '{}')
    const report = await pending
    expect(report.outcome).toBe('prepared')
    expect(markedDuringHooks).toBe(false)
    expect(realpathSync(join(profile.home, 'plugins'))).toBe(
      realpathSync(join(f.defaultHome, 'plugins'))
    )
    expect(readFileSync(join(f.defaultHome, 'plugins', 'claude-only.json'), 'utf8')).toBe('{}')
    expect(JSON.parse(readFileSync(marker, 'utf8'))).toEqual({
      version: 1,
      accountId: 'a',
      runtime: 'host'
    })
  })

  itLinks('refuses a data root linked into the default home before writing there', async () => {
    const f = fixture()
    mkdirSync(join(f.defaultHome, 'inner'))
    symlinkSync(join(f.defaultHome, 'inner'), join(f.dataRoot, 'claude-profiles'))
    expect((await f.setup()).outcome).toBe('refused')
    expect(existsSync(join(f.defaultHome, 'inner', 'a'))).toBe(false)
  })
})
