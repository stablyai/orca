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

const MANAGED_STATUS_LINE = {
  type: 'command',
  command: '"$HOME/.orca/agent-hooks/claude-statusline.sh"'
}
const USER_HOOK = { matcher: '', hooks: [{ type: 'command', command: 'notify-me' }] }
const ORCA_HOOK = {
  matcher: '',
  hooks: [{ type: 'command', command: '"$HOME/.orca/agent-hooks/claude-hook.sh"' }]
}
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
const provision = (f: { profileHome: string; userHome: string }, trustKeys?: string[]) =>
  provisionClaudeProfile({ profileHome: f.profileHome, userHome: f.userHome, trustKeys })
afterEach(() => {
  vi.clearAllMocks()
  for (const dir of roots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('dormant Claude profile provisioning', () => {
  it('links resources, keeps private directories and sees later global installs', async () => {
    const f = fixture()
    for (const name of ['skills', 'plugins', 'agents', 'commands', 'output-styles']) {
      fs.mkdirSync(join(f.source, name))
    }
    fs.mkdirSync(join(f.profileHome, 'agents'))
    fs.writeFileSync(join(f.profileHome, 'agents/mine.md'), 'private')
    const report = await provision(f)
    expect(report.surfaces.agents).toBe('user-owned')
    for (const name of ['skills', 'plugins', 'commands', 'output-styles']) {
      expect(fs.realpathSync(join(f.profileHome, name))).toBe(fs.realpathSync(join(f.source, name)))
    }
    fs.writeFileSync(join(f.source, 'skills/new.md'), 'new skill')
    expect(fs.readFileSync(join(f.profileHome, 'skills/new.md'), 'utf8')).toBe('new skill')
    expect(fs.readFileSync(join(f.profileHome, 'agents/mine.md'), 'utf8')).toBe('private')
  })
  it("shares future settings keys and the user's hooks but excludes auth and Orca hooks; profile edits survive reprovision", async () => {
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
      hooks: { Stop: [USER_HOOK] },
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
  it('re-adds a shared key the profile deleted and leaves a linked settings file alone', async () => {
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
  })
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
    f.json(join(f.profileHome, '.claude.json'), { userID: 'p' })
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
      theme: 'dark',
      hasCompletedOnboarding: true
    })
  })
  it('keeps Orca managed statusLine out of the merge but shares a user statusLine over it', async () => {
    const f = fixture()
    f.json(join(f.source, 'settings.json'), { statusLine: MANAGED_STATUS_LINE, model: 'a' })
    await provision(f)
    expect(f.read(join(f.profileHome, 'settings.json'))).toEqual({ model: 'a' })
    f.json(join(f.profileHome, 'settings.json'), { model: 'a', statusLine: MANAGED_STATUS_LINE })
    const custom = { type: 'command', command: 'my-statusline' }
    f.json(join(f.source, 'settings.json'), { statusLine: custom, model: 'a' })
    await provision(f)
    expect(f.read(join(f.profileHome, 'settings.json')).statusLine).toEqual(custom)
  })
  it('requires existing state, merges MCP/theme/onboarding/trust and never copies or writes credentials', async () => {
    const f = fixture()
    fs.writeFileSync(join(f.source, '.credentials.json'), 'SOURCE_CREDENTIAL_BYTES')
    f.json(join(f.userHome, '.claude.json'), {
      mcpServers: { local: { command: 'example' } },
      theme: 'dark',
      oauthAccount: { email: 'source' },
      userID: 'source-id'
    })
    await provision(f)
    expect(fs.existsSync(join(f.profileHome, '.claude.json'))).toBe(false)
    expect(fs.existsSync(join(f.profileHome, '.credentials.json'))).toBe(false)
    fs.writeFileSync(join(f.profileHome, '.credentials.json'), 'PROFILE_CREDENTIAL_BYTES')
    f.json(join(f.profileHome, '.claude.json'), {
      oauthAccount: { email: 'profile' },
      userID: 'profile-id',
      projects: { '/work': { allowedTools: ['Read'] } }
    })
    await provision(f, ['/work'])
    expect(f.read(join(f.profileHome, '.claude.json'))).toEqual({
      oauthAccount: { email: 'profile' },
      userID: 'profile-id',
      mcpServers: { local: { command: 'example' } },
      theme: 'dark',
      hasCompletedOnboarding: true,
      projects: { '/work': { allowedTools: ['Read'], hasTrustDialogAccepted: true } }
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
  it('still forces onboarding and trust when the personal state is unreadable', async () => {
    const f = fixture()
    fs.writeFileSync(join(f.userHome, '.claude.json'), '{"theme": "da')
    f.json(join(f.profileHome, '.claude.json'), { userID: 'p' })
    const report = await provision(f, ['/work'])
    expect(f.read(join(f.profileHome, '.claude.json'))).toEqual({
      userID: 'p',
      hasCompletedOnboarding: true,
      projects: { '/work': { hasTrustDialogAccepted: true } }
    })
    expect(report.warnings).toContainEqual(
      expect.objectContaining({ surface: '.claude.json', code: 'unreadable' })
    )
  })
  it('skips only folder trust when the profile projects value is malformed', async () => {
    const f = fixture()
    f.json(join(f.userHome, '.claude.json'), { theme: 'dark' })
    f.json(join(f.profileHome, '.claude.json'), { userID: 'p', projects: 'bad' })
    const report = await provision(f, ['/work'])
    expect(report.surfaces['.claude.json']).toBe('merged')
    expect(f.read(join(f.profileHome, '.claude.json'))).toEqual({
      userID: 'p',
      projects: 'bad',
      theme: 'dark',
      hasCompletedOnboarding: true
    })
    expect(report.warnings).toEqual([
      expect.objectContaining({ surface: '.claude.json', code: 'trust-refused' })
    ])
  })
  it('skips the state write while Claude holds its lock and records nothing for it', async () => {
    const f = fixture()
    f.json(join(f.userHome, '.claude.json'), { theme: 'dark' })
    f.json(join(f.profileHome, '.claude.json'), { userID: 'p' })
    fs.mkdirSync(join(f.profileHome, '.claude.json.lock'))
    const report = await provision(f)
    expect(report.surfaces['.claude.json']).toBe('failed')
    expect(report.warnings).toContainEqual(
      expect.objectContaining({ surface: '.claude.json', code: 'locked' })
    )
    expect(f.read(join(f.profileHome, '.claude.json'))).toEqual({ userID: 'p' })
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
  it('resets an unreadable ledger instead of blocking every surface', async () => {
    const f = fixture()
    fs.mkdirSync(join(f.source, 'skills'))
    f.json(join(f.source, 'settings.json'), { model: 'a' })
    fs.writeFileSync(join(f.profileHome, '.orca-profile.json'), '')
    const report = await provision(f)
    expect(report.surfaces.skills).toBe('linked')
    expect(report.surfaces['settings.json']).toBe('merged')
    expect(report.warnings).toContainEqual(
      expect.objectContaining({ surface: 'ledger', code: 'unreadable' })
    )
    expect(f.read(join(f.profileHome, '.orca-profile.json')).keys).toEqual({
      'settings.json': { model: '"a"' }
    })
  })
  it('keys shared values by surface, so another spelling of the profile keeps sharing', async () => {
    const f = fixture()
    fs.writeFileSync(join(f.source, 'CLAUDE.md'), 'v1')
    f.json(join(f.source, 'settings.json'), { model: 'a' })
    await provision(f)
    fs.writeFileSync(join(f.source, 'CLAUDE.md'), 'v2')
    f.json(join(f.source, 'settings.json'), { model: 'b' })
    const aliasRoot = fs.mkdtempSync(join(tmpdir(), 'claude-profile-alias-'))
    roots.push(aliasRoot)
    const alias = join(aliasRoot, 'link')
    fs.symlinkSync(f.root, alias)
    const report = await provisionClaudeProfile({
      profileHome: join(alias, 'profile'),
      userHome: f.userHome
    })
    expect(report.surfaces['CLAUDE.md']).toBe('synced')
    expect(f.read(join(f.profileHome, 'settings.json')).model).toBe('b')
  })
  it('uses Windows junctions through platform injection (native Windows remains unverified)', async () => {
    const f = fixture()
    fs.mkdirSync(join(f.source, 'skills'))
    await provisionClaudeProfile({ ...f, platform: 'win32' })
    expect(fs.symlinkSync).toHaveBeenCalledWith(
      fs.realpathSync(join(f.source, 'skills')),
      join(f.profileHome, 'skills'),
      'junction'
    )
  })
  it('refuses default-home aliases and nesting, and leaves malformed profile state unchanged', async () => {
    const f = fixture()
    for (const profileHome of [f.source, join(f.source, 'inner'), f.userHome]) {
      await expect(provisionClaudeProfile({ profileHome, userHome: f.userHome })).rejects.toThrow(
        'separate directories'
      )
    }
    expect(fs.existsSync(join(f.source, 'inner'))).toBe(false)
    fs.writeFileSync(join(f.profileHome, '.claude.json'), '{bad')
    expect((await provision(f)).warnings).toContainEqual(
      expect.objectContaining({ surface: '.claude.json', code: 'unreadable' })
    )
    expect(fs.readFileSync(join(f.profileHome, '.claude.json'), 'utf8')).toBe('{bad')
  })
})
