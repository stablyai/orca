import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { ClaudeProfileRouter } from '../claude-accounts/claude-profile-router'
import * as installedRouter from '../claude-accounts/claude-profile-installed-router'
import { agentSessionRecordFixture } from '../native-chat/agent-session-record-test-fixture'
import type { StructuredAgentLaunchSources } from '../runtime/structured-agent-launch-composition'
import { claudeNamingInvocation } from './claude-naming-invocation'

it('captures configured command, overlay and pure selected-account policy before awaited input resolution', async ({
  onTestFinished
}) => {
  const root = await mkdtemp(join(tmpdir(), 'orca-naming-inputs-'))
  onTestFinished(async () => {
    vi.restoreAllMocks()
    await rm(root, { recursive: true, force: true })
  })
  const router = new ClaudeProfileRouter({
    getSettings: () => ({
      claudeManagedAccounts: [],
      activeClaudeManagedAccountId: null,
      agentStatusHooksEnabled: false,
      disabledTuiAgents: []
    }),
    dataRoot: root,
    userHome: root,
    env: {}
  })
  const selected = join(root, 'selected-account')
  const later = join(root, 'later-account')
  const preparation = vi.spyOn(router, 'preparation').mockReturnValue({
    configDir: selected,
    runtime: 'host',
    wslDistro: null,
    wslLinuxConfigDir: null,
    envPatch: { CLAUDE_CONFIG_DIR: selected },
    provenance: 'profile:a'
  })
  const prepareLaunch = vi.spyOn(router, 'prepareLaunch')
  vi.spyOn(installedRouter, 'getClaudeProfileRouter').mockReturnValue(router)
  const record = agentSessionRecordFixture({
    sessionId: 'chat',
    accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: join(root, 'saved-account') }
  })
  const inherited = Promise.withResolvers<Record<string, string>>()
  const settings = { agentCmdOverrides: { claude: `"${process.execPath}"` } }
  const overlay = { CLAUDE_CONFIG_DIR: join(root, 'overlay-account'), NAMING_INPUT: 'accepted' }
  const sources: StructuredAgentLaunchSources = {
    store: {
      selectWritableRecord: () => ({ kind: 'writable', record }),
      requireWritableRecord: () => record,
      pinLaunchDirectory: async () => record
    },
    resolveWorkspacePath: async () => root,
    resolveBaseEnvironment: () => inherited.promise,
    resolveAgentEnvironment: async () => overlay,
    resolveAgentLaunchEnv: () => overlay,
    resolveCommandSettings: () => settings
  }
  const snapshot = claudeNamingInvocation(sources, () => [])
  const pending = snapshot(record)
  settings.agentCmdOverrides.claude = 'does-not-exist-orca-naming'
  overlay.NAMING_INPUT = 'changed'
  preparation.mockReturnValue({
    configDir: later,
    runtime: 'host',
    wslDistro: null,
    wslLinuxConfigDir: null,
    envPatch: { CLAUDE_CONFIG_DIR: later },
    provenance: 'profile:b'
  })
  inherited.resolve({ HOME: root, PATH: process.env.PATH ?? '' })
  expect(await pending).toMatchObject({
    command: process.execPath,
    home: selected,
    cwd: root,
    env: { CLAUDE_CONFIG_DIR: selected, NAMING_INPUT: 'accepted' }
  })
  expect(prepareLaunch).not.toHaveBeenCalled()
  await expect(snapshot(record)).rejects.toThrow()
  expect(prepareLaunch).not.toHaveBeenCalled()
})
