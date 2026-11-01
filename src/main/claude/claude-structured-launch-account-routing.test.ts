import { createClaudeStructuredLaunchResolver } from '../runtime/structured-agent-launch-composition.test-support'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve as resolvePath } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { agentSessionRecordFixture } from '../../shared/agent-session-record.test-fixture'
import { claudeProviderHandle } from '../../shared/agent-session-provider-handle-encoding'
import type { AgentSessionRewindRecord } from '../../shared/agent-session-rewind'
import {
  CLAUDE_PROFILE_MISSING_MESSAGE,
  CLAUDE_PROFILE_SETUP_FAILED_MESSAGE
} from '../../shared/claude-profile-routing'
import {
  ClaudeProfileRouter,
  type ClaudeProfileRouterSettings
} from '../claude-accounts/claude-profile-router'
import { installClaudeProfileRouter } from '../claude-accounts/claude-profile-installed-router'
import { resolveStructuredClaudeAccountHomePath } from '../runtime/structured-agent-account-home'
import { structuredAgentRuntimeMetadata } from '../runtime/structured-agent-runtime-metadata'

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
  const runSetup = vi.fn(async () => {
    throw new Error('setup refused')
  })
  const router = new ClaudeProfileRouter({
    getSettings: () => settings,
    dataRoot: root,
    userHome: join(root, 'personal'),
    env: { CLAUDE_CONFIG_DIR: resolvePath('/user/own') },
    runSetup
  })
  const follows = () => structuredAgentRuntimeMetadata('claude')?.launchFollowsSelection?.()
  // Without a router a launch keeps the record's home, so a running chat is never compared.
  expect(follows()).toBe(false)
  installClaudeProfileRouter(router)
  expect(follows()).toBe(true)
  // What a running chat is compared against is the folder a launch runs under, so a switch
  // replaces it once and no route replaces it before every message.
  const read = (purpose?: 'identity') =>
    resolveStructuredClaudeAccountHomePath({
      launchEnv: {},
      wslDistro: null,
      ...(purpose ? { purpose } : {}),
      getClaudeConfigDirectory: () => router.systemDefaultHome()
    })
  const home = join(root, 'claude-profiles', 'a', 'home')
  // Dispatch identity names the selected account before its folder exists; availability reads refuse.
  expect(read('identity')).toBe(home)
  expect(() => read()).toThrow(CLAUDE_PROFILE_MISSING_MESSAGE)
  expect(runSetup).not.toHaveBeenCalled()
  const record = {
    ...agentSessionRecordFixture(),
    providerHandleChain: [],
    accountHome: { variable: 'CLAUDE_CONFIG_DIR' as const, path: '/created/under/b' }
  }
  const resolve = createClaudeStructuredLaunchResolver({
    store: { getRecord: () => record, pinLaunchDirectory: vi.fn() },
    resolveLaunchArgs: () => [],
    resolveWorkspacePath: async (id) => `/repos/${id}`,
    resolveCommand: () => ({ command: '/usr/local/bin/claude', prefixArgs: [] }),
    resolveInheritedEnv: async () => ({ PATH: '/usr/bin' }),
    resolveAuthPolicy: () => ({ account: 'system' })
  })
  const identity = {
    sessionId: record.sessionId,
    workspaceId: 'workspace-1',
    hostId: 'local',
    agent: 'claude' as const,
    providerHandle: claudeProviderHandle('unused', null)
  }

  await expect(resolve({ identity })).rejects.toMatchObject({
    name: 'AgentSessionPreSpawnError',
    reason: 'claudeAccountSetupFailed',
    message: CLAUDE_PROFILE_SETUP_FAILED_MESSAGE
  })
  expect(runSetup).toHaveBeenCalled()

  mkdirSync(home, { recursive: true })
  writeFileSync(join(root, 'claude-profiles', 'a', 'profile.json'), '{}')
  const routed = await resolve({ identity })
  expect(routed.claudeConfigDir).toBe(home)
  expect(read()).toBe(home)
  expect(read('identity')).toBe(home)
  expect(routed.env).toMatchObject({
    CLAUDE_CONFIG_DIR: home,
    ORCA_CLAUDE_INJECTED_CONFIG_DIR: home
  })

  const receipt = routed.accountRecipe
  expect(receipt).toEqual({ route: 'managed', accountId: 'a', home })
  settings.activeClaudeManagedAccountId = null
  expect((await resolve({ identity })).claudeConfigDir).toBe(resolvePath('/user/own'))
  const prepareAccount = vi.spyOn(router, 'prepareReceivingAccount')
  expect((await resolve({ identity, accountRecipe: receipt })).claudeConfigDir).toBe(home)
  expect(prepareAccount).toHaveBeenCalledWith('a')
  expect(settings.activeClaudeManagedAccountId).toBeNull()
  prepareAccount.mockRestore()
  expect(read()).toBe(resolvePath('/user/own'))
})

function routedResumeFixture(rewind?: AgentSessionRewindRecord, transcriptFiles = false) {
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
    ],
    ...(rewind ? { rewind } : {})
  }
  const transcriptHomes = new Set<string>()
  const resolve = createClaudeStructuredLaunchResolver({
    store: { getRecord: () => record, pinLaunchDirectory: vi.fn() },
    resolveLaunchArgs: () => [],
    resolveWorkspacePath: async (id) => `/repos/${id}`,
    resolveCommand: () => ({ command: '/usr/local/bin/claude', prefixArgs: [] }),
    resolveInheritedEnv: async () => ({ PATH: '/usr/bin' }),
    resolveAuthPolicy: () => ({ account: 'system' }),
    hasTranscript: transcriptFiles
      ? undefined
      : async ({ claudeConfigDir }) => transcriptHomes.has(claudeConfigDir)
  })
  const identity = {
    sessionId: record.sessionId,
    workspaceId: 'workspace-1',
    hostId: 'local',
    agent: 'claude' as const,
    providerHandle: handle
  }
  return { root, home, record, transcriptHomes, launch: () => resolve({ identity }) }
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

it('refuses to resume a chat whose transcript is only in its saved custom home', async () => {
  const { root, record, transcriptHomes, launch } = routedResumeFixture()
  const customHome = join(root, 'custom-claude-home')
  record.accountHome = { variable: 'CLAUDE_CONFIG_DIR', path: customHome }
  transcriptHomes.add(customHome)

  await expect(launch()).rejects.toMatchObject({
    name: 'AgentSessionPreSpawnError',
    reason: 'historyInOtherAccount'
  })
})

it('resumes a chat with a stored leaf whose transcript is in no known folder', async () => {
  const { launch } = routedResumeFixture()

  const resumed = await launch()
  expect(resumed.options).toMatchObject({ resume: 'ran-under-b' })
  expect(resumed.resumeLeafUuid).toBe('leaf-1')
})

it('refuses a rewind fork from its saved custom home and recovers when its source reaches the selected account', async () => {
  const { root, home, record, launch } = routedResumeFixture(
    {
      operationId: 'rewind-1',
      callerKey: 'desktop',
      itemId: 'item-1',
      expectedEpoch: 'epoch-1',
      phase: 'completed',
      providerFork: {
        sessionId: 'forked',
        sourceSessionId: 'ran-under-b',
        throughEntryId: 'entry-1',
        replacesSessionId: 'ran-under-b'
      }
    },
    true
  )
  const customHome = join(root, 'custom-claude-home')
  record.accountHome = { variable: 'CLAUDE_CONFIG_DIR', path: customHome }
  const sourceProject = join(customHome, 'projects', '-repos-workspace-1')
  mkdirSync(sourceProject, { recursive: true })
  writeFileSync(join(sourceProject, 'ran-under-b.jsonl'), '{}\n')

  await expect(launch()).rejects.toMatchObject({
    name: 'AgentSessionPreSpawnError',
    reason: 'historyInOtherAccount'
  })

  const selectedProject = join(home, 'projects', '-repos-workspace-1')
  mkdirSync(selectedProject, { recursive: true })
  writeFileSync(join(selectedProject, 'ran-under-b.jsonl'), '{}\n')
  expect((await launch()).options).toMatchObject({
    sessionId: 'forked',
    resume: 'ran-under-b',
    resumeSessionAt: 'entry-1',
    forkSession: true
  })
})
