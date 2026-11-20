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

describe("Orca's agy and its kill switch", () => {
  it.each([
    ["agy's own home", AGY_HOME],
    ["Orca's chat home", ORCA_HOME]
  ])("launches Orca's agy on %s only while it is switched on", async (_case, home) => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { rememberManagedAgentRelease } =
      await import('../managed-agent-cli/managed-agent-cli-registry')
    const { resolveAcpLaunchCommand } = await import('../acp/launch/acp-launch-command')
    const folder = mkdtempSync(join(tmpdir(), 'orcas-agy-'))
    writeFileSync(join(folder, process.platform === 'win32' ? 'agy.exe' : 'agy'), '')
    rememberManagedAgentRelease('antigravity', folder)
    try {
      const spec = acpLaunchSpecForAccount(ANTIGRAVITY_LAUNCH_SPEC, home)
      const resolve = (antigravityManagedAgyEnabled: boolean) =>
        resolveAcpLaunchCommand(
          spec,
          { PATH: '' },
          { homePath: folder, commandSettings: { antigravityManagedAgyEnabled } }
        ).command
      expect(resolve(true)).toContain(folder)
      expect(() => resolve(false)).not.toThrow()
      expect(resolve(false)).not.toContain(folder)
    } finally {
      rememberManagedAgentRelease('antigravity', null)
      rmSync(folder, { recursive: true, force: true })
    }
  })
})
