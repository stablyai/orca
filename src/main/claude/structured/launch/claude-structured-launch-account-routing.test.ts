import { createClaudeStructuredLaunchResolver } from '../../../runtime/agent-session/launch/structured-agent-launch-composition.test-support'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { agentSessionRecordFixture } from '../../../../shared/agent-session/lifecycle/agent-session-record.test-fixture'
import { claudeProviderHandle } from '../../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'
import type { AgentSessionRewindRecord } from '../../../../shared/agent-session/lifecycle/agent-session-rewind'
import { ClaudeProfileRouter } from '../../../claude-accounts/claude-profile-router'
import { installClaudeProfileRouter } from '../../../claude-accounts/claude-profile-installed-router'

const roots: string[] = []
afterEach(() => {
  installClaudeProfileRouter(undefined)
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }))
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
