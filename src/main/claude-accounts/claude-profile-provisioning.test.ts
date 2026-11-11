import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as FsUtils from '../filesystem/atomic-file-publication'
vi.mock('electron', () => ({ app: { getPath: () => '/unused-test-path' } }))
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof fs>()
  return { ...actual, symlinkSync: vi.fn(actual.symlinkSync) }
})
vi.mock('../filesystem/atomic-file-publication', async (original) => {
  const actual = await original<typeof FsUtils>()
  return { ...actual, writeFileAtomically: vi.fn(actual.writeFileAtomically) }
})
import { provisionClaudeProfile } from './claude-profile-provisioning'

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

describe('Claude profile refresh from the default home', () => {
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

  it('shares configuration while keeping profile runtime state and API authorizations private', async () => {
    const f = fixture()
    fs.writeFileSync(join(f.source, '.credentials.json'), 'SOURCE_CREDENTIAL_BYTES')
    const shared = {
      mcpServers: { local: { command: 'example' } },
      theme: 'dark',
      hasCompletedOnboarding: true,
      bypassPermissionsModeAccepted: true,
      favoritePlugins: ['favorite@example'],
      preferTmuxOverIterm2: true,
      codeReviewLastEffort: 'high',
      codeReviewLastMaxFindings: 3,
      installMethod: 'global',
      autoUpdates: false,
      autoUpdatesProtectedForNative: false,
      customApiKeyResponses: { rejected: ['PERSONAL_REJECTED_SUFFIX'] },
      projects: { '/work': { hasTrustDialogAccepted: true } }
    }
    const personal = {
      ...shared,
      customApiKeyResponses: {
        approved: ['PERSONAL_APPROVED_SUFFIX'],
        rejected: ['PERSONAL_REJECTED_SUFFIX']
      },
      groveChoiceSeenAt: { personal: 1 },
      numStartups: 2,
      tipsHistory: { tip: 1 },
      seenNotifications: { notice: 1 },
      penguinModeOrgEnabled: false,
      futureRuntimeState: { personal: true },
      autoModeAccepted: true,
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
    }
    f.json(join(f.userHome, '.claude.json'), personal)
    expect((await provision(f)).surfaces['.claude.json']).toBe('synced')
    expect(f.read(join(f.profileHome, '.claude.json'))).toEqual(shared)
    expect(fs.readdirSync(f.profileHome).filter((name) => name.endsWith('.tmp'))).toEqual([])
    expect(fs.existsSync(join(f.profileHome, '.credentials.json'))).toBe(false)

    fs.writeFileSync(join(f.profileHome, '.credentials.json'), 'PROFILE_CREDENTIAL_BYTES')
    const profileRuntime = {
      groveChoiceSeenAt: { profile: 20 },
      numStartups: 30,
      tipsHistory: { tip: 8 },
      seenNotifications: { profileNotice: 9 },
      penguinModeOrgEnabled: true,
      futureRuntimeState: { profile: true },
      customApiKeyResponses: {
        approved: ['PROFILE_APPROVED_SUFFIX', 'PERSONAL_REJECTED_SUFFIX'],
        rejected: ['PROFILE_REJECTED_SUFFIX', 'PERSONAL_APPROVED_SUFFIX'],
        profileOnly: true
      }
    }
    f.json(join(f.profileHome, '.claude.json'), {
      ...profileRuntime,
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
      ...shared,
      ...profileRuntime,
      hasCompletedOnboarding: true,
      customApiKeyResponses: {
        approved: ['PROFILE_APPROVED_SUFFIX', 'PERSONAL_REJECTED_SUFFIX'],
        rejected: [
          'PROFILE_REJECTED_SUFFIX',
          'PERSONAL_APPROVED_SUFFIX',
          'PERSONAL_REJECTED_SUFFIX'
        ],
        profileOnly: true
      }
    })
    const reset = { ...f.read(join(f.profileHome, '.claude.json')), hasCompletedOnboarding: false }
    f.json(join(f.profileHome, '.claude.json'), reset)
    f.json(join(f.userHome, '.claude.json'), {
      ...personal,
      numStartups: 1000,
      groveChoiceSeenAt: { personal: 1000 },
      futureRuntimeState: { changed: true }
    })
    expect((await provision(f)).surfaces['.claude.json']).toBe('unchanged')
    expect(f.read(join(f.profileHome, '.claude.json'))).toEqual(reset)
    expect(fs.readFileSync(join(f.source, '.credentials.json'), 'utf8')).toBe(
      'SOURCE_CREDENTIAL_BYTES'
    )
    expect(fs.readFileSync(join(f.profileHome, '.credentials.json'), 'utf8')).toBe(
      'PROFILE_CREDENTIAL_BYTES'
    )
  })
})
