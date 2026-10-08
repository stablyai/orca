import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve as resolvePath } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { agentSessionRecordFixture } from '../../shared/agent-session-record.test-fixture'
import { claudeProviderHandle } from '../../shared/agent-session-provider-handle-encoding'
import {
  CLAUDE_PROFILE_MISSING_MESSAGE,
  ClaudeProfileRouter,
  type ClaudeProfileRouterSettings
} from '../claude-accounts/claude-profile-router'
import { installClaudeProfileRouter } from '../claude-accounts/claude-profile-installed-router'
import {
  createClaudeStructuredLaunchResolver,
  type ClaudeStructuredLaunchResolverDeps
} from './claude-structured-launch-resolution'

const roots: string[] = []
afterEach(() => {
  installClaudeProfileRouter(undefined)
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }))
})

it('launches each acquisition under the current selection, not the account it was created under', async () => {
  const root = mkdtempSync(join(tmpdir(), 'claude-launch-routing-'))
  roots.push(root)
  const settings: ClaudeProfileRouterSettings = {
    claudeManagedAccounts: [],
    activeClaudeManagedAccountId: 'a',
    activeClaudeManagedAccountIdsByRuntime: undefined,
    agentStatusHooksEnabled: false,
    disabledTuiAgents: []
  }
  const router = new ClaudeProfileRouter({
    getSettings: () => settings,
    dataRoot: root,
    userHome: join(root, 'personal'),
    env: { CLAUDE_CONFIG_DIR: resolvePath('/user/own') }
  })
  installClaudeProfileRouter(router)
  const record = {
    ...agentSessionRecordFixture(),
    providerHandleChain: [],
    accountHome: { variable: 'CLAUDE_CONFIG_DIR' as const, path: '/created/under/b' }
  }
  const resolve = createClaudeStructuredLaunchResolver({
    store: { getRecord: () => record, pinLaunchDirectory: vi.fn() },
    resolveLaunchArgs: () => [],
    resolveWorkspacePath: async (id) => `/repos/${id}`,
    resolveCommand: () => '/usr/local/bin/claude',
    resolveInheritedEnv: async () => ({ PATH: '/usr/bin' }),
    resolveAuthPolicy: () => ({ stripAuthEnv: false })
  })
  const identity = {
    sessionId: record.sessionId,
    workspaceId: 'workspace-1',
    hostId: 'local',
    agent: 'claude' as const,
    providerHandle: claudeProviderHandle('unused', null)
  }

  await expect(resolve({ identity })).rejects.toThrow(CLAUDE_PROFILE_MISSING_MESSAGE)

  const home = join(root, 'claude-profiles', 'a', 'home')
  mkdirSync(home, { recursive: true })
  // Already set up, so the launch does not wait for setup.
  writeFileSync(join(root, 'claude-profiles', 'a', 'profile.json'), '{}')
  const routed = await resolve({ identity })
  expect(routed.claudeConfigDir).toBe(home)
  expect(routed.env).toMatchObject({
    CLAUDE_CONFIG_DIR: home,
    ORCA_CLAUDE_INJECTED_CONFIG_DIR: home
  })

  settings.activeClaudeManagedAccountId = null
  expect((await resolve({ identity })).claudeConfigDir).toBe(resolvePath('/user/own'))
})

function routedResumeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'claude-launch-routing-'))
  roots.push(root)
  const home = join(root, 'claude-profiles', 'a', 'home')
  mkdirSync(home, { recursive: true })
  writeFileSync(join(root, 'claude-profiles', 'a', 'profile.json'), '{}')
  installClaudeProfileRouter(
    new ClaudeProfileRouter({
      getSettings: () => ({
        claudeManagedAccounts: [],
        activeClaudeManagedAccountId: 'a',
        activeClaudeManagedAccountIdsByRuntime: undefined,
        agentStatusHooksEnabled: false,
        disabledTuiAgents: []
      }),
      dataRoot: root,
      userHome: join(root, 'personal'),
      env: {}
    })
  )
  const handle = claudeProviderHandle('ran-under-b', 'leaf-1')
  const record = {
    ...agentSessionRecordFixture(),
    providerHandleChain: [
      { linkId: 'link-1', origin: 'created' as const, mintedAtFence: 1, observedAt: 1, handle }
    ]
  }
  const transcriptHomes = new Set<string>()
  const deps: ClaudeStructuredLaunchResolverDeps = {
    store: { getRecord: () => record, pinLaunchDirectory: vi.fn() },
    resolveLaunchArgs: () => [],
    resolveWorkspacePath: async (id) => `/repos/${id}`,
    resolveCommand: () => '/usr/local/bin/claude',
    resolveInheritedEnv: async () => ({ PATH: '/usr/bin' }),
    resolveAuthPolicy: () => ({ stripAuthEnv: false }),
    hasTranscript: async ({ claudeConfigDir }) => transcriptHomes.has(claudeConfigDir)
  }
  const resolve = createClaudeStructuredLaunchResolver(deps)
  const identity = {
    sessionId: record.sessionId,
    workspaceId: 'workspace-1',
    hostId: 'local',
    agent: 'claude' as const,
    providerHandle: handle
  }
  // The same chat as a fork reserves it: no conversation yet, cut from the one that ran under B.
  const forkSession = vi.fn(async () => 'copy-1')
  const forked = {
    ...record,
    providerHandleChain: [],
    forkedFrom: {
      sessionId: 'parent-chat',
      itemId: 'answer-1',
      providerSessionId: 'ran-under-b',
      forkPoint: 'leaf-1'
    }
  }
  const launchFork = () =>
    createClaudeStructuredLaunchResolver({
      ...deps,
      store: { getRecord: () => forked, pinLaunchDirectory: vi.fn() },
      forkSession
    })({ identity: { ...identity, providerHandle: null } })
  return {
    root,
    home,
    transcriptHomes,
    launch: () => resolve({ identity }),
    launchFork,
    forkSession
  }
}

it('refuses to resume a chat whose transcript is in another account instead of starting fresh', async () => {
  const { root, home, transcriptHomes, launch } = routedResumeFixture()
  transcriptHomes.add(join(root, 'personal', '.claude'))

  await expect(launch()).rejects.toMatchObject({
    name: 'AgentSessionPreSpawnError',
    reason: 'historyInOtherAccount'
  })

  transcriptHomes.add(home)
  const resumed = await launch()
  expect(resumed.options).toMatchObject({ resume: 'ran-under-b' })
  expect(resumed.resumeLeafUuid).toBe('leaf-1')
})

it('resumes a chat with a stored leaf whose transcript is in no known folder', async () => {
  const { launch } = routedResumeFixture()

  const resumed = await launch()
  expect(resumed.options).toMatchObject({ resume: 'ran-under-b' })
  expect(resumed.resumeLeafUuid).toBe('leaf-1')
})

it('refuses to fork a chat whose transcript is in another account, before copying anything', async () => {
  const { root, transcriptHomes, launchFork, forkSession } = routedResumeFixture()
  transcriptHomes.add(join(root, 'personal', '.claude'))

  await expect(launchFork()).rejects.toMatchObject({
    name: 'AgentSessionPreSpawnError',
    reason: 'historyInOtherAccount'
  })
  expect(forkSession).not.toHaveBeenCalled()
})
