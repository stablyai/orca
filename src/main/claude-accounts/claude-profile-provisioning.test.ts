import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as FsUtils from '../filesystem/atomic-file-publication'
import type * as SecureFile from '../../shared/secure-storage/secure-file'
const secureFile = vi.hoisted(() => ({ canProtect: true }))
vi.mock('electron', () => ({ app: { getPath: () => '/unused-test-path' } }))
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof fs>()
  return { ...actual, symlinkSync: vi.fn(actual.symlinkSync) }
})
vi.mock('../filesystem/atomic-file-publication', async (original) => {
  const actual = await original<typeof FsUtils>()
  return { ...actual, writeFileAtomically: vi.fn(actual.writeFileAtomically) }
})
vi.mock('../../shared/secure-storage/secure-file', async (original) => {
  const actual = await original<typeof SecureFile>()
  return {
    ...actual,
    writeSecureFile: (...args: Parameters<typeof actual.writeSecureFile>) =>
      actual.writeSecureFile(...args) && secureFile.canProtect
  }
})
import { provisionClaudeProfile } from './claude-profile-provisioning'
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
  secureFile.canProtect = true
  vi.clearAllMocks()
  for (const dir of roots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// Real symlinks require additional privileges on Windows.
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
    fs.writeFileSync(join(f.source, 'statusline.sh'), 'echo hi')
    fs.chmodSync(join(f.source, 'statusline.sh'), 0o755)
    await provision(f)
    expect(fs.statSync(join(f.profileHome, 'statusline.sh')).mode & 0o777).toBe(0o755)
  })

  it('keeps settings Claude saved in the account while later default-home edits still arrive', async () => {
    const f = fixture()
    const settings = { effortLevel: 'medium', env: { ANTHROPIC_BASE_URL: 'https://a.test' } }
    f.json(join(f.source, 'settings.json'), settings)
    await provision(f)
    // What Claude 2.1.318 saves for `/model opus` then `/effort high`.
    const saved = {
      ...settings,
      model: 'opus',
      effortLevel: 'high',
      modelSettings: { 'claude-opus-5-5': { effortLevel: 'high' } }
    }
    f.json(join(f.profileHome, 'settings.json'), saved)
    expect((await provision(f)).surfaces['settings.json']).toBe('unchanged')
    expect(f.read(join(f.profileHome, 'settings.json'))).toEqual(saved)
    f.json(join(f.source, 'settings.json'), {
      ...settings,
      env: { ANTHROPIC_BASE_URL: 'https://b.test' },
      apiKeyHelper: 'helper'
    })
    expect((await provision(f)).surfaces['settings.json']).toBe('synced')
    expect(f.read(join(f.profileHome, 'settings.json'))).toEqual({
      effortLevel: 'high',
      env: { ANTHROPIC_BASE_URL: 'https://b.test' },
      model: 'opus',
      modelSettings: { 'claude-opus-5-5': { effortLevel: 'high' } },
      apiKeyHelper: 'helper'
    })
  })

  itLinks('leaves a linked settings file alone', async () => {
    const f = fixture()
    f.json(join(f.source, 'settings.json'), { model: 'a', theme: 'x' })
    await provision(f)
    const elsewhere = join(f.root, 'elsewhere.json')
    f.json(elsewhere, { mine: true })
    fs.rmSync(join(f.profileHome, 'settings.json'))
    fs.symlinkSync(elsewhere, join(f.profileHome, 'settings.json'))
    expect((await provision(f)).surfaces['settings.json']).toBe('user-owned')
    expect(f.read(elsewhere)).toEqual({ mine: true })
  })
  it('leaves no endpoint settings behind when they cannot be protected', async () => {
    const f = fixture()
    secureFile.canProtect = false
    const report = await provisionClaudeProfile({
      profileHome: f.profileHome,
      userHome: f.userHome,
      platform: 'linux',
      endpointEnv: { ANTHROPIC_AUTH_TOKEN: 'endpoint-token' }
    })
    expect(report.surfaces['settings.json']).toBe('failed')
    expect(fs.existsSync(join(f.profileHome, 'settings.json'))).toBe(false)
  })
  it('drops the endpoint settings once the folder no longer has an endpoint', async () => {
    const f = fixture()
    f.json(join(f.source, 'settings.json'), { model: 'a' })
    await provision(f)
    await provisionClaudeProfile({
      profileHome: f.profileHome,
      userHome: f.userHome,
      platform: 'linux',
      endpointEnv: { ANTHROPIC_AUTH_TOKEN: 'endpoint-token' }
    })
    expect(fs.readFileSync(join(f.profileHome, 'settings.json'), 'utf8')).toContain(
      'endpoint-token'
    )
    // The default home did not change, so only a full rewrite removes the token.
    await provision(f)
    expect(f.read(join(f.profileHome, 'settings.json'))).toEqual({ model: 'a' })
  })
  it('adds an endpoint account’s env over the user’s settings and drops other credentials', async () => {
    const f = fixture()
    f.json(join(f.source, 'settings.json'), {
      model: 'a',
      apiKeyHelper: 'helper',
      env: {
        ANTHROPIC_BASE_URL: 'https://proxy.example.test',
        ANTHROPIC_API_KEY: 'proxy-key',
        CLAUDE_CODE_USE_BEDROCK: '1',
        NORMAL: 'yes'
      }
    })
    const endpointEnv = {
      ANTHROPIC_BASE_URL: 'https://api.example.test',
      ANTHROPIC_AUTH_TOKEN: 'endpoint-token'
    }
    const run = () =>
      provisionClaudeProfile({
        profileHome: f.profileHome,
        userHome: f.userHome,
        platform: 'linux',
        endpointEnv
      })
    expect((await run()).surfaces['settings.json']).toBe('synced')
    const target = join(f.profileHome, 'settings.json')
    const env = f.read(target).env as Record<string, string>
    expect(f.read(target).model).toBe('a')
    expect(f.read(target).apiKeyHelper).toBeUndefined()
    // Cleared, not omitted, so the same names exported by a shell cannot apply either.
    expect(env).toMatchObject({
      NORMAL: 'yes',
      ...endpointEnv,
      ANTHROPIC_API_KEY: '',
      ANTHROPIC_CUSTOM_HEADERS: '',
      CLAUDE_CODE_USE_BEDROCK: '0',
      CLAUDE_CODE_USE_ANTHROPIC_AWS: '0'
    })
    if (process.platform !== 'win32') {
      expect(fs.statSync(target).mode & 0o777).toBe(0o600)
    }
    expect((await run()).surfaces['settings.json']).toBe('unchanged')
    fs.rmSync(join(f.source, 'settings.json'))
    expect((await run()).surfaces['settings.json']).toBe('synced')
    expect(Object.keys(f.read(target))).toEqual(['env'])
    expect(f.read(target).env).toMatchObject(endpointEnv)
  })
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
      groveChoiceSeenAt: { 'account-a': 99, 'account-b': 10 },
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
    expect((await provision(f)).surfaces['.claude.json']).toBe('synced')
    expect(f.read(join(f.profileHome, '.claude.json'))).toEqual({
      ...shared,
      groveChoiceSeenAt: { 'account-a': 99, 'account-b': 10 }
    })
    expect(fs.readdirSync(f.profileHome).filter((name) => name.endsWith('.tmp'))).toEqual([])
    expect(fs.existsSync(join(f.profileHome, '.credentials.json'))).toBe(false)

    fs.writeFileSync(join(f.profileHome, '.credentials.json'), 'PROFILE_CREDENTIAL_BYTES')
    f.json(join(f.profileHome, '.claude.json'), {
      oauthAccount: { emailAddress: 'profile@example.com' },
      userID: 'profile-id',
      groveConfigCache: { b: 2 },
      groveChoiceSeenAt: { 'account-a': 120, 'account-b': 5 },
      theme: 'light',
      onlyHere: true
    })
    expect((await provision(f)).surfaces['.claude.json']).toBe('merged')
    expect(f.read(join(f.profileHome, '.claude.json'))).toEqual({
      oauthAccount: { emailAddress: 'profile@example.com' },
      userID: 'profile-id',
      groveConfigCache: { b: 2 },
      groveChoiceSeenAt: { 'account-a': 120, 'account-b': 10 },
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
