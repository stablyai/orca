import { describe, expect, it } from 'vitest'
import type { AntigravityChatAuthConfig } from '../../shared/agent-accounts/antigravity/antigravity-chat-auth-config'
import { acpLaunchSpecForAccount } from '../acp/launch/acp-launch-command'
import { ANTIGRAVITY_LAUNCH_SPEC } from './antigravity-acp-launch-spec'

const AGY_HOME = { variable: 'GEMINI_HOME', path: '/home/u/.gemini' }
const ORCA_HOME = { variable: 'GEMINI_HOME', path: '/data/antigravity-chat' }

function input(antigravityChatAuth?: AntigravityChatAuthConfig) {
  return {
    command: '/usr/local/bin/agy',
    env: {},
    envToDelete: [],
    homePath: '/home/u',
    stateDirectory: '/data',
    settings: antigravityChatAuth ? { antigravityChatAuth } : {},
    startsProgram: false
  }
}

describe('Antigravity chat homes', () => {
  it.each<[string, AntigravityChatAuthConfig | undefined]>([
    ['nothing saved', undefined],
    ['Google', { method: 'oauth-personal' }],
    ['an older Gemini Enterprise choice', { method: 'oauth-business', gcpProject: 'p' }]
  ])("runs new chats on agy's own home and login with %s", async (_case, saved) => {
    expect(await ANTIGRAVITY_LAUNCH_SPEC.hostBackend.select(input(saved))).toEqual(AGY_HOME)
  })

  it.each<[string, AntigravityChatAuthConfig | undefined]>([
    ['a Gemini API key', { method: 'gemini-api-key' }],
    ['gcloud', { method: 'agent-platform', gcpProject: 'p' }]
  ])("runs new chats on Orca's chat home with %s", async (_case, saved) => {
    expect(await ANTIGRAVITY_LAUNCH_SPEC.hostBackend.select(input(saved))).toBeNull()
  })

  it("launches agy on Orca's chat home, where the retired server's chats live", () => {
    const spec = acpLaunchSpecForAccount(ANTIGRAVITY_LAUNCH_SPEC, ORCA_HOME)

    expect(spec.command).toBe('agy')
    expect(spec.args({ fullAccess: true, pluginDirs: [] })).toEqual([
      'acp',
      '--dangerously-skip-permissions',
      '--gemini-dir',
      '/data/antigravity-chat',
      '--app-data-dir',
      'antigravity-acp'
    ])
  })

  it('launches agy on its own home without pointing it elsewhere', () => {
    const spec = acpLaunchSpecForAccount(ANTIGRAVITY_LAUNCH_SPEC, AGY_HOME)

    expect(spec.args({ fullAccess: false, pluginDirs: [] })).toEqual(['acp'])
  })

  it("keeps a Gemini API key for agy's own settings, which may read it", () => {
    const env = { GEMINI_API_KEY: 'key', GOOGLE_API_KEY: 'other', PATH: '/bin' }

    ANTIGRAVITY_LAUNCH_SPEC.hostBackend.spec.scrubEnvironment?.(env, {})

    expect(env).toEqual({ GEMINI_API_KEY: 'key', GOOGLE_API_KEY: 'other', PATH: '/bin' })
  })
})
