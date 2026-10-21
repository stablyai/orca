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

describe('Claude profile refresh from the default home', () => {
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
  it('copies top-level files over the profile copy, edited or not', async () => {
    const f = fixture()
    const source = join(f.source, 'keybindings.json')
    const copy = join(f.profileHome, 'keybindings.json')
    fs.writeFileSync(source, '{"bindings":[]}')
    expect((await provision(f)).surfaces['keybindings.json']).toBe('synced')
    expect(fs.lstatSync(copy).isSymbolicLink()).toBe(false)
    expect(fs.readFileSync(copy, 'utf8')).toBe('{"bindings":[]}')
    expect((await provision(f)).surfaces['keybindings.json']).toBe('unchanged')
    fs.writeFileSync(copy, '{"bindings":["profile"]}')
    fs.writeFileSync(source, '{"bindings":[2]}')
    expect((await provision(f)).surfaces['keybindings.json']).toBe('synced')
    expect(fs.readFileSync(copy, 'utf8')).toBe('{"bindings":[2]}')
    // A file Claude does not know yet is shared the same way, with its mode.
    fs.writeFileSync(join(f.source, 'statusline.sh'), 'echo hi')
    fs.chmodSync(join(f.source, 'statusline.sh'), 0o755)
    await provision(f)
    expect(fs.statSync(join(f.profileHome, 'statusline.sh')).mode & 0o777).toBe(0o755)
  })
  it('copies settings whole, proxy key and auth included, over profile edits', async () => {
    const f = fixture()
    const settings = {
      futureFeature: true,
      model: 'a',
      hooks: { Stop: [USER_HOOK, ORCA_HOOK], SessionStart: [ORCA_HOOK] },
      apiKeyHelper: 'helper',
      env: {
        ANTHROPIC_BASE_URL: 'https://proxy.example.test',
        ANTHROPIC_API_KEY: 'proxy-key',
        ANTHROPIC_AUTH_TOKEN: 'token',
        CLAUDE_CODE_OAUTH_TOKEN: 'oauth',
        NORMAL: 'yes'
      }
    }
    f.json(join(f.source, 'settings.json'), settings)
    await provision(f)
    expect(f.read(join(f.profileHome, 'settings.json'))).toEqual(settings)
    // A `/model` change made on the account lasts only until the next refresh.
    f.json(join(f.profileHome, 'settings.json'), { ...settings, model: 'private' })
    f.json(join(f.source, 'settings.json'), { model: 'b' })
    expect((await provision(f)).surfaces['settings.json']).toBe('synced')
    expect(f.read(join(f.profileHome, 'settings.json'))).toEqual({ model: 'b' })
    expect((await provision(f)).surfaces['settings.json']).toBe('unchanged')
    fs.rmSync(join(f.source, 'settings.json'))
    await provision(f)
    expect(fs.existsSync(join(f.profileHome, 'settings.json'))).toBe(false)
  })
  itLinks(
    'restores settings the profile changed and leaves a linked settings file alone',
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
  it('copies state except the login, caches and install ids, and never copies credentials', async () => {
    const f = fixture()
    fs.writeFileSync(join(f.source, '.credentials.json'), 'SOURCE_CREDENTIAL_BYTES')
    const shared = {
      mcpServers: { local: { command: 'example' } },
      theme: 'dark',
      hasCompletedOnboarding: true,
      autoModeAccepted: true,
      projects: { '/work': { hasTrustDialogAccepted: true } }
    }
    f.json(join(f.userHome, '.claude.json'), {
      ...shared,
      oauthAccount: { emailAddress: 'source@example.com' },
      primaryApiKey: 'sk-source',
      userID: 'source-id',
      machineID: 'source-machine',
      firstStartTime: 'source-start',
      firstStartVersion: '1.0.0',
      groveConfigCache: { a: 1 },
      cachedArtifactRoster: [],
      clientDataCacheSlots: {},
      passesEligibilityCache: {},
      passesLastSeen: 1,
      claudeCodeFirstTokenDate: 'source-date',
      startupPrefetchedAt: 1,
      additionalModelOptionsAnsweredAt: 1,
      artifactRosterDenied: true,
      lastSeenOrgDefaultUpdatedAt: 1,
      hasAvailableSubscription: true,
      subscriptionNoticeCount: 2
    })
    // A folder with no state file yet gets one without a login, so Claude asks for its own.
    expect((await provision(f)).surfaces['.claude.json']).toBe('synced')
    expect(f.read(join(f.profileHome, '.claude.json'))).toEqual(shared)
    // Published whole through a staged file, which is gone afterwards.
    expect(fs.readdirSync(f.profileHome).filter((name) => name.endsWith('.tmp'))).toEqual([])
    expect(fs.existsSync(join(f.profileHome, '.credentials.json'))).toBe(false)

    fs.writeFileSync(join(f.profileHome, '.credentials.json'), 'PROFILE_CREDENTIAL_BYTES')
    f.json(join(f.profileHome, '.claude.json'), {
      oauthAccount: { emailAddress: 'profile@example.com' },
      userID: 'profile-id',
      groveConfigCache: { b: 2 },
      theme: 'light',
      onlyHere: true
    })
    expect((await provision(f)).surfaces['.claude.json']).toBe('merged')
    expect(f.read(join(f.profileHome, '.claude.json'))).toEqual({
      oauthAccount: { emailAddress: 'profile@example.com' },
      userID: 'profile-id',
      groveConfigCache: { b: 2 },
      onlyHere: true,
      ...shared
    })
    expect((await provision(f)).surfaces['.claude.json']).toBe('unchanged')
    expect(fs.readFileSync(join(f.source, '.credentials.json'), 'utf8')).toBe(
      'SOURCE_CREDENTIAL_BYTES'
    )
    expect(fs.readFileSync(join(f.profileHome, '.credentials.json'), 'utf8')).toBe(
      'PROFILE_CREDENTIAL_BYTES'
    )
  })
  itLinks(
    "shares user content, never Claude's runtime state, live sessions or login files",
    async () => {
      const f = fixture()
      const unsharedDirs = [
        'daemon',
        'jobs',
        'state',
        'sessions',
        'teams',
        'ide',
        'remote-control',
        'shares',
        'uploads',
        'storage-v2',
        'downloads',
        'scratch',
        'agent-memory-local',
        '.hidden-dir'
      ]
      for (const name of [...unsharedDirs, 'skills', 'plugins', 'my-own-dir']) {
        fs.mkdirSync(join(f.source, name))
      }
      const unsharedFiles = [
        'daemon.status.json',
        '.credentials.json',
        '.session_ingress_token',
        'hfi-auth.json',
        'server-sessions.json',
        'active-time.json',
        'computer-use.lock',
        'gh-pr-status-cache.json',
        'loop.md',
        'policy-limits.json',
        'mcp-needs-auth-cache.json',
        'stats-cache.json',
        '.last-update-check',
        '.config.json',
        '.claude.json',
        '.claude.json.backup.1'
      ]
      for (const name of unsharedFiles) {
        fs.writeFileSync(join(f.source, name), 'x')
      }
      // The account's own runtime file is never overwritten from the default home.
      fs.writeFileSync(join(f.profileHome, 'server-sessions.json'), 'mine')
      await provision(f)
      for (const name of ['skills', 'plugins', 'my-own-dir']) {
        expect(fs.realpathSync(join(f.profileHome, name))).toBe(
          fs.realpathSync(join(f.source, name))
        )
      }
      for (const name of [...unsharedDirs, ...unsharedFiles].filter(
        (name) => name !== 'server-sessions.json'
      )) {
        expect(fs.existsSync(join(f.profileHome, name))).toBe(false)
      }
      expect(fs.readFileSync(join(f.profileHome, 'server-sessions.json'), 'utf8')).toBe('mine')
    }
  )
  it('merges trusted folders and MCP servers per entry, never untrusting an account folder', async () => {
    const f = fixture()
    f.json(join(f.userHome, '.claude.json'), {
      projects: {
        '/shared': { hasTrustDialogAccepted: false, allowedTools: ['Read'] },
        '/default-only': { hasTrustDialogAccepted: true }
      },
      mcpServers: { shared: { command: 'default' } }
    })
    f.json(join(f.profileHome, '.claude.json'), {
      oauthAccount: LOGIN,
      projects: {
        '/shared': { hasTrustDialogAccepted: true },
        '/account-only': { hasTrustDialogAccepted: true, allowedTools: ['Bash'] }
      },
      mcpServers: { shared: { command: 'account' }, mine: { command: 'mine' } }
    })
    await provision(f)
    expect(f.read(join(f.profileHome, '.claude.json'))).toEqual({
      oauthAccount: LOGIN,
      projects: {
        '/shared': { hasTrustDialogAccepted: true, allowedTools: ['Read'] },
        '/account-only': { hasTrustDialogAccepted: true, allowedTools: ['Bash'] },
        '/default-only': { hasTrustDialogAccepted: true }
      },
      mcpServers: { shared: { command: 'default' }, mine: { command: 'mine' } }
    })
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
  it('retries a failed settings copy on the next refresh', async () => {
    const f = fixture()
    f.json(join(f.source, 'settings.json'), { theme: 'dark' })
    await provision(f)
    f.json(join(f.source, 'settings.json'), { theme: 'light' })
    vi.mocked(writeFileAtomically).mockImplementationOnce(() => {
      throw Object.assign(new Error('busy'), { code: 'EBUSY' })
    })
    expect((await provision(f)).surfaces['settings.json']).toBe('failed')
    expect((await provision(f)).surfaces['settings.json']).toBe('synced')
    expect(f.read(join(f.profileHome, 'settings.json')).theme).toBe('light')
  })
  it('imports the personal CLAUDE.md instead of copying it, so Claude loads it once', async () => {
    const f = fixture()
    await provision(f)
    expect(fs.existsSync(join(f.profileHome, 'CLAUDE.md'))).toBe(false)
    fs.writeFileSync(join(f.source, 'CLAUDE.md'), 'personal instructions')
    expect((await provision(f)).surfaces['CLAUDE.md']).toBe('synced')
    expect(fs.readFileSync(join(f.profileHome, 'CLAUDE.md'), 'utf8')).toBe('@~/.claude/CLAUDE.md\n')
    fs.writeFileSync(join(f.source, 'CLAUDE.md'), 'edited personal instructions')
    expect((await provision(f)).surfaces['CLAUDE.md']).toBe('unchanged')
    fs.writeFileSync(join(f.profileHome, 'CLAUDE.md'), 'edited in the profile')
    expect((await provision(f)).surfaces['CLAUDE.md']).toBe('synced')
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
    f.json(join(f.userHome, '.claude.json'), { theme: 'dark' })
    fs.writeFileSync(join(f.profileHome, '.claude.json'), '{bad')
    expect((await provision(f)).warnings).toContainEqual(
      expect.objectContaining({ surface: '.claude.json', code: 'unreadable' })
    )
    expect(fs.readFileSync(join(f.profileHome, '.claude.json'), 'utf8')).toBe('{bad')
  })
})
