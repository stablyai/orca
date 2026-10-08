import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as FsUtils from '../codex-accounts/fs-utils'
vi.mock('electron', () => ({ app: { getPath: () => '/unused-test-path' } }))
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof fs>()
  return { ...actual, symlinkSync: vi.fn(actual.symlinkSync) }
})
vi.mock('../codex-accounts/fs-utils', async (original) => {
  const actual = await original<typeof FsUtils>()
  return { ...actual, writeFileAtomically: vi.fn(actual.writeFileAtomically) }
})
import { writeFileAtomically } from '../codex-accounts/fs-utils'
import { provisionClaudeProfile } from './claude-profile-provisioning'

const USER_HOOK = { matcher: '', hooks: [{ type: 'command', command: 'notify-me' }] }
const ORCA_HOOK = {
  matcher: '',
  hooks: [{ type: 'command', command: '"$HOME/.orca/agent-hooks/claude-hook.sh"' }]
}
// What Claude writes on a finished sign-in.
const LOGIN = { emailAddress: 'p@example.com' }
const roots: string[] = []
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'claude-profile-setup-')))
  roots.push(root)
  const userHome = join(root, 'user')
  const profileHome = join(root, 'profile')
  const source = join(userHome, '.claude')
  fs.mkdirSync(source, { recursive: true })
  fs.mkdirSync(profileHome)
  const json = (file: string, value: unknown): void => fs.writeFileSync(file, JSON.stringify(value))
  const read = (file: string): Record<string, unknown> => JSON.parse(fs.readFileSync(file, 'utf8'))
  return { root, userHome, profileHome, source, json, read }
}
const provision = (f: { profileHome: string; userHome: string }) =>
  provisionClaudeProfile({ profileHome: f.profileHome, userHome: f.userHome, platform: 'linux' })
afterEach(() => {
  vi.clearAllMocks()
  for (const dir of roots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// Why: these create real symlinks, which Windows needs privilege for.
const itLinks = it.skipIf(process.platform === 'win32')

describe('dormant Claude profile provisioning', () => {
  itLinks('links resources, keeps private directories and sees later global installs', async () => {
    const f = fixture()
    const linked = [
      'skills',
      'plugins',
      'commands',
      'output-styles',
      'themes',
      'workflows'
    ] as const
    for (const name of [...linked, 'agents', 'rules']) {
      fs.mkdirSync(join(f.source, name))
    }
    for (const name of ['agents', 'rules']) {
      fs.mkdirSync(join(f.profileHome, name))
      fs.writeFileSync(join(f.profileHome, name, 'mine.md'), 'private')
    }
    const report = await provision(f)
    expect(report.surfaces.agents).toBe('user-owned')
    expect(report.surfaces.rules).toBe('user-owned')
    for (const name of linked) {
      expect(report.surfaces[name]).toBe('linked')
      expect(fs.realpathSync(join(f.profileHome, name))).toBe(fs.realpathSync(join(f.source, name)))
    }
    fs.writeFileSync(join(f.source, 'skills/new.md'), 'new skill')
    expect(fs.readFileSync(join(f.profileHome, 'skills/new.md'), 'utf8')).toBe('new skill')
    for (const name of ['agents', 'rules']) {
      expect(fs.readFileSync(join(f.profileHome, name, 'mine.md'), 'utf8')).toBe('private')
    }
  })
  itLinks(
    'shares personal rules, themes and workflows that later appear in the default home',
    async () => {
      const f = fixture()
      await provision(f)
      fs.mkdirSync(join(f.source, 'rules'))
      fs.writeFileSync(join(f.source, 'rules/style.md'), 'use tabs')
      fs.mkdirSync(join(f.source, 'themes'))
      fs.writeFileSync(join(f.source, 'themes/dusk.json'), '{"base":"dark"}')
      fs.mkdirSync(join(f.source, 'workflows'))
      fs.writeFileSync(join(f.source, 'workflows/review.js'), 'export const meta = {}')
      const report = await provision(f)
      expect(report.surfaces).toMatchObject({
        rules: 'linked',
        themes: 'linked',
        workflows: 'linked'
      })
      expect(fs.readFileSync(join(f.profileHome, 'rules/style.md'), 'utf8')).toBe('use tabs')
      expect(fs.readFileSync(join(f.profileHome, 'themes/dusk.json'), 'utf8')).toBe(
        '{"base":"dark"}'
      )
      expect(fs.readFileSync(join(f.profileHome, 'workflows/review.js'), 'utf8')).toBe(
        'export const meta = {}'
      )
      fs.writeFileSync(join(f.profileHome, 'workflows/saved.js'), 'saved in profile')
      expect(fs.readFileSync(join(f.source, 'workflows/saved.js'), 'utf8')).toBe('saved in profile')
    }
  )
  it('copies keybindings, keeps a profile edit and follows the default while unedited', async () => {
    const f = fixture()
    const source = join(f.source, 'keybindings.json')
    const copy = join(f.profileHome, 'keybindings.json')
    fs.writeFileSync(source, '{"bindings":[]}')
    expect((await provision(f)).surfaces['keybindings.json']).toBe('synced')
    expect(fs.lstatSync(copy).isSymbolicLink()).toBe(false)
    expect(fs.readFileSync(copy, 'utf8')).toBe('{"bindings":[]}')
    fs.writeFileSync(source, '{"bindings":[1]}')
    expect((await provision(f)).surfaces['keybindings.json']).toBe('synced')
    expect(fs.readFileSync(copy, 'utf8')).toBe('{"bindings":[1]}')
    fs.writeFileSync(copy, '{"bindings":["profile"]}')
    fs.writeFileSync(source, '{"bindings":[2]}')
    expect((await provision(f)).surfaces['keybindings.json']).toBe('user-owned')
    expect(fs.readFileSync(copy, 'utf8')).toBe('{"bindings":["profile"]}')
    expect(fs.readFileSync(source, 'utf8')).toBe('{"bindings":[2]}')
  })
  it('shares future settings keys and hooks but excludes auth; profile edits survive reprovision', async () => {
    const f = fixture()
    f.json(join(f.source, 'settings.json'), {
      futureFeature: true,
      model: 'a',
      hooks: { Stop: [USER_HOOK, ORCA_HOOK], SessionStart: [ORCA_HOOK] },
      apiKeyHelper: 'secret',
      awsAuthRefresh: 'secret',
      awsCredentialExport: 'secret',
      forceLoginMethod: 'secret',
      forceLoginOrgUUID: 'secret',
      env: {
        ANTHROPIC_API_KEY: 'secret',
        ANTHROPIC_AUTH_TOKEN: 'secret',
        CLAUDE_CODE_OAUTH_TOKEN: 'secret',
        NORMAL: 'yes'
      }
    })
    fs.writeFileSync(join(f.source, 'CLAUDE.md'), 'source')
    await provision(f)
    expect(f.read(join(f.profileHome, 'settings.json'))).toEqual({
      futureFeature: true,
      model: 'a',
      hooks: { Stop: [USER_HOOK, ORCA_HOOK], SessionStart: [ORCA_HOOK] },
      env: { NORMAL: 'yes' }
    })
    f.json(join(f.profileHome, 'settings.json'), {
      futureFeature: true,
      model: 'private',
      env: { NORMAL: 'yes' }
    })
    fs.writeFileSync(join(f.profileHome, 'CLAUDE.md'), 'private instructions')
    f.json(join(f.source, 'settings.json'), { model: 'b', futureFeature: false })
    fs.writeFileSync(join(f.source, 'CLAUDE.md'), 'updated source')
    await provision(f)
    expect(f.read(join(f.profileHome, 'settings.json'))).toMatchObject({
      model: 'private',
      futureFeature: false
    })
    expect(fs.readFileSync(join(f.profileHome, 'CLAUDE.md'), 'utf8')).toBe('private instructions')
  })
  itLinks(
    're-adds a shared key the profile deleted and leaves a linked settings file alone',
    async () => {
      const f = fixture()
      f.json(join(f.source, 'settings.json'), { model: 'a', theme: 'x' })
      await provision(f)
      f.json(join(f.profileHome, 'settings.json'), { theme: 'x' })
      await provision(f)
      expect(f.read(join(f.profileHome, 'settings.json'))).toEqual({ model: 'a', theme: 'x' })
      const elsewhere = join(f.root, 'elsewhere.json')
      f.json(elsewhere, { mine: true })
      fs.rmSync(join(f.profileHome, 'settings.json'))
      fs.symlinkSync(elsewhere, join(f.profileHome, 'settings.json'))
      expect((await provision(f)).surfaces['settings.json']).toBe('user-owned')
      expect(f.read(elsewhere)).toEqual({ mine: true })
    }
  )
  it('removes a key the default dropped unless the profile changed it, and only keys Orca shared', async () => {
    const f = fixture()
    const settings = join(f.source, 'settings.json')
    f.json(settings, { model: 'a', theme: 'x', apiKeyHelper: 'source-secret' })
    await provision(f)
    f.json(join(f.profileHome, 'settings.json'), {
      ...f.read(join(f.profileHome, 'settings.json')),
      theme: 'mine',
      local: true,
      apiKeyHelper: 'profile-helper'
    })
    f.json(settings, { apiKeyHelper: 'source-secret' })
    expect((await provision(f)).surfaces['settings.json']).toBe('merged')
    expect(f.read(join(f.profileHome, 'settings.json'))).toEqual({
      theme: 'mine',
      local: true,
      apiKeyHelper: 'profile-helper'
    })
    expect((await provision(f)).surfaces['settings.json']).toBe('unchanged')
    f.json(settings, { model: 'b' })
    await provision(f)
    fs.rmSync(settings)
    await provision(f)
    expect(f.read(join(f.profileHome, 'settings.json'))).toEqual({
      theme: 'mine',
      local: true,
      apiKeyHelper: 'profile-helper'
    })
    const ledger = f.read(join(f.profileHome, '.orca-profile.json'))
    expect(JSON.stringify(ledger)).not.toContain('apiKeyHelper')
  })
  it('removes nothing while the default settings or state are unreadable', async () => {
    const f = fixture()
    f.json(join(f.source, 'settings.json'), { model: 'a' })
    f.json(join(f.userHome, '.claude.json'), { mcpServers: { a: {} }, theme: 'dark' })
    f.json(join(f.profileHome, '.claude.json'), { userID: 'p', oauthAccount: LOGIN })
    await provision(f)
    fs.writeFileSync(join(f.source, 'settings.json'), '{bad')
    fs.writeFileSync(join(f.userHome, '.claude.json'), '{bad')
    await provision(f)
    expect(f.read(join(f.profileHome, 'settings.json'))).toEqual({ model: 'a' })
    expect(f.read(join(f.profileHome, '.claude.json'))).toMatchObject({
      mcpServers: { a: {} },
      theme: 'dark'
    })
    f.json(join(f.userHome, '.claude.json'), { theme: 'dark' })
    await provision(f)
    expect(f.read(join(f.profileHome, '.claude.json'))).toEqual({
      userID: 'p',
      oauthAccount: LOGIN,
      theme: 'dark',
      hasCompletedOnboarding: true
    })
  })
  it('requires existing state, merges MCP/theme/onboarding and never copies or writes credentials', async () => {
    const f = fixture()
    fs.writeFileSync(join(f.source, '.credentials.json'), 'SOURCE_CREDENTIAL_BYTES')
    f.json(join(f.userHome, '.claude.json'), {
      mcpServers: { local: { command: 'example' } },
      theme: 'dark',
      oauthAccount: { emailAddress: 'source@example.com' },
      userID: 'source-id'
    })
    await provision(f)
    expect(fs.existsSync(join(f.profileHome, '.claude.json'))).toBe(false)
    expect(fs.existsSync(join(f.profileHome, '.credentials.json'))).toBe(false)
    fs.writeFileSync(join(f.profileHome, '.credentials.json'), 'PROFILE_CREDENTIAL_BYTES')
    f.json(join(f.profileHome, '.claude.json'), {
      oauthAccount: { emailAddress: 'profile@example.com' },
      userID: 'profile-id',
      projects: { '/work': { allowedTools: ['Read'] } }
    })
    await provision(f)
    expect(f.read(join(f.profileHome, '.claude.json'))).toEqual({
      oauthAccount: { emailAddress: 'profile@example.com' },
      userID: 'profile-id',
      mcpServers: { local: { command: 'example' } },
      theme: 'dark',
      hasCompletedOnboarding: true,
      projects: { '/work': { allowedTools: ['Read'] } }
    })
    expect(fs.readFileSync(join(f.source, '.credentials.json'), 'utf8')).toBe(
      'SOURCE_CREDENTIAL_BYTES'
    )
    expect(fs.readFileSync(join(f.profileHome, '.credentials.json'), 'utf8')).toBe(
      'PROFILE_CREDENTIAL_BYTES'
    )
    for (const name of fs.readdirSync(f.profileHome)) {
      const file = join(f.profileHome, name)
      if (fs.lstatSync(file).isFile()) {
        expect(fs.readFileSync(file, 'utf8')).not.toContain('SOURCE_CREDENTIAL_BYTES')
      }
    }
  })
  it('leaves a folder Claude has not signed in yet to Claude’s own onboarding', async () => {
    const f = fixture()
    f.json(join(f.userHome, '.claude.json'), { theme: 'dark', mcpServers: { a: {} } })
    // Claude writes its state file at the theme pick, before the sign-in.
    f.json(join(f.profileHome, '.claude.json'), { theme: 'light' })
    expect((await provision(f)).surfaces['.claude.json']).toBe('absent')
    expect(f.read(join(f.profileHome, '.claude.json'))).toEqual({ theme: 'light' })
    f.json(join(f.profileHome, '.claude.json'), { theme: 'light', oauthAccount: LOGIN })
    expect((await provision(f)).surfaces['.claude.json']).toBe('merged')
    expect(f.read(join(f.profileHome, '.claude.json'))).toEqual({
      theme: 'light',
      oauthAccount: LOGIN,
      mcpServers: { a: {} },
      hasCompletedOnboarding: true
    })
  })
  it('still forces onboarding when the personal state is unreadable', async () => {
    const f = fixture()
    fs.writeFileSync(join(f.userHome, '.claude.json'), '{"theme": "da')
    f.json(join(f.profileHome, '.claude.json'), { userID: 'p', oauthAccount: LOGIN })
    const report = await provision(f)
    expect(f.read(join(f.profileHome, '.claude.json'))).toEqual({
      userID: 'p',
      oauthAccount: LOGIN,
      hasCompletedOnboarding: true
    })
    expect(report.warnings).toContainEqual(
      expect.objectContaining({ surface: '.claude.json', code: 'unreadable' })
    )
  })
  it('skips the state write while Claude holds its lock and records nothing for it', async () => {
    const f = fixture()
    f.json(join(f.userHome, '.claude.json'), { theme: 'dark' })
    f.json(join(f.profileHome, '.claude.json'), { userID: 'p', oauthAccount: LOGIN })
    fs.mkdirSync(join(f.profileHome, '.claude.json.lock'))
    const report = await provision(f)
    expect(report.surfaces['.claude.json']).toBe('failed')
    expect(report.warnings).toContainEqual(
      expect.objectContaining({ surface: '.claude.json', code: 'locked' })
    )
    expect(f.read(join(f.profileHome, '.claude.json'))).toEqual({
      userID: 'p',
      oauthAccount: LOGIN
    })
    fs.rmdirSync(join(f.profileHome, '.claude.json.lock'))
    expect((await provision(f)).surfaces['.claude.json']).toBe('merged')
    expect(f.read(join(f.profileHome, '.claude.json')).theme).toBe('dark')
  })
  it('records a shared value only after its write succeeded', async () => {
    const f = fixture()
    f.json(join(f.source, 'settings.json'), { theme: 'dark' })
    await provision(f)
    f.json(join(f.source, 'settings.json'), { theme: 'light' })
    vi.mocked(writeFileAtomically).mockImplementationOnce(() => {
      throw Object.assign(new Error('busy'), { code: 'EBUSY' })
    })
    expect((await provision(f)).surfaces['settings.json']).toBe('failed')
    expect((await provision(f)).surfaces['settings.json']).toBe('merged')
    expect(f.read(join(f.profileHome, 'settings.json')).theme).toBe('light')
  })
  itLinks('resets an unreadable ledger instead of blocking every surface', async () => {
    const f = fixture()
    fs.mkdirSync(join(f.source, 'skills'))
    f.json(join(f.source, 'settings.json'), { model: 'a' })
    fs.writeFileSync(join(f.profileHome, '.orca-profile.json'), '')
    const report = await provision(f)
    expect(report.surfaces.skills).toBe('linked')
    expect(report.surfaces['settings.json']).toBe('merged')
    expect(report.warnings).toEqual([])
    expect(f.read(join(f.profileHome, '.orca-profile.json')).keys).toEqual({
      'settings.json': { model: '"a"' }
    })
  })
  itLinks(
    'keys shared values by surface, so another spelling of the profile keeps sharing',
    async () => {
      const f = fixture()
      fs.writeFileSync(join(f.source, 'keybindings.json'), 'v1')
      f.json(join(f.source, 'settings.json'), { model: 'a' })
      await provision(f)
      fs.writeFileSync(join(f.source, 'keybindings.json'), 'v2')
      f.json(join(f.source, 'settings.json'), { model: 'b' })
      const aliasRoot = fs.mkdtempSync(join(tmpdir(), 'claude-profile-alias-'))
      roots.push(aliasRoot)
      const alias = join(aliasRoot, 'link')
      fs.symlinkSync(f.root, alias)
      const report = await provisionClaudeProfile({
        profileHome: join(alias, 'profile'),
        userHome: f.userHome,
        platform: 'linux'
      })
      expect(report.surfaces['keybindings.json']).toBe('synced')
      expect(f.read(join(f.profileHome, 'settings.json')).model).toBe('b')
    }
  )
  it('imports the personal CLAUDE.md instead of copying it, so Claude loads it once', async () => {
    const f = fixture()
    await provision(f)
    expect(fs.existsSync(join(f.profileHome, 'CLAUDE.md'))).toBe(false)
    fs.writeFileSync(join(f.source, 'CLAUDE.md'), 'personal instructions')
    expect((await provision(f)).surfaces['CLAUDE.md']).toBe('synced')
    expect(fs.readFileSync(join(f.profileHome, 'CLAUDE.md'), 'utf8')).toBe('@~/.claude/CLAUDE.md\n')
    fs.writeFileSync(join(f.source, 'CLAUDE.md'), 'edited personal instructions')
    expect((await provision(f)).surfaces['CLAUDE.md']).toBe('unchanged')
  })
  itLinks(
    "shares from the user's own CLAUDE_CONFIG_DIR, copying its CLAUDE.md and state",
    async () => {
      const f = fixture()
      const userConfigDir = join(f.userHome, 'custom-claude')
      fs.mkdirSync(join(userConfigDir, 'skills'), { recursive: true })
      fs.writeFileSync(join(userConfigDir, 'CLAUDE.md'), 'custom instructions')
      f.json(join(userConfigDir, 'settings.json'), { model: 'custom' })
      f.json(join(userConfigDir, '.claude.json'), { theme: 'custom' })
      f.json(join(f.userHome, '.claude.json'), { theme: 'home' })
      f.json(join(f.profileHome, '.claude.json'), { userID: 'p', oauthAccount: LOGIN })
      await provisionClaudeProfile({ ...f, userConfigDir, platform: 'linux' })
      expect(fs.realpathSync(join(f.profileHome, 'skills'))).toBe(join(userConfigDir, 'skills'))
      expect(fs.readFileSync(join(f.profileHome, 'CLAUDE.md'), 'utf8')).toBe('custom instructions')
      expect(f.read(join(f.profileHome, 'settings.json'))).toEqual({ model: 'custom' })
      expect(f.read(join(f.profileHome, '.claude.json')).theme).toBe('custom')
    }
  )
  itLinks("links to the default home's own entry, not where a user link of it points", async () => {
    const f = fixture()
    fs.mkdirSync(join(f.root, 'dotfiles-skills'))
    fs.symlinkSync(join(f.root, 'dotfiles-skills'), join(f.source, 'skills'))
    expect((await provision(f)).surfaces.skills).toBe('linked')
    expect(fs.readlinkSync(join(f.profileHome, 'skills'))).toBe(join(f.source, 'skills'))
    expect((await provision(f)).surfaces.skills).toBe('unchanged')
  })
  it('uses Windows junctions through platform injection (native Windows remains unverified)', async () => {
    const f = fixture()
    fs.mkdirSync(join(f.source, 'skills'))
    await provisionClaudeProfile({ ...f, platform: 'win32' })
    expect(fs.symlinkSync).toHaveBeenCalledWith(
      join(f.source, 'skills'),
      join(f.profileHome, 'skills'),
      'junction'
    )
  })
  it('leaves malformed profile state unchanged', async () => {
    const f = fixture()
    fs.writeFileSync(join(f.profileHome, '.claude.json'), '{bad')
    expect((await provision(f)).warnings).toContainEqual(
      expect.objectContaining({ surface: '.claude.json', code: 'unreadable' })
    )
    expect(fs.readFileSync(join(f.profileHome, '.claude.json'), 'utf8')).toBe('{bad')
  })
})
