import { expect, it, vi } from 'vitest'
import { CLAUDE_STRUCTURED_AGENT } from '../../claude/claude-structured-agent-definition'
import { CODEX_STRUCTURED_AGENT } from '../../codex/codex-structured-agent-definition'
import { createClaudeStructuredLaunchResolver } from '../../claude/claude-structured-launch-resolution'
import { claudeStructuredSpawnOptions } from '../../claude/claude-structured-spawn-options'
import { createCodexStructuredLaunchResolver } from '../../codex/codex-structured-launch-resolution'
import { restoredCodexSessionOptions } from '../../codex/codex-structured-session-options'
import { adoptCodexOpenedPermissionState } from '../../codex/codex-structured-permission-mode'
import { parseAgentSessionPermissionModes } from '../../../shared/agent-chat-permission-mode'
import { record } from './structured-agent-session-restart-resume-test-harness'
import {
  readStructuredAgentSessionOptionsAtRest,
  recordStructuredAgentSessionOptionIntent
} from './structured-agent-session-options-read'

it.each(['claude', 'codex'] as const)(
  'offers stopped %s Auto intent, then resumes an explicit Ask pick',
  async (provider) => {
    const saved = {
      ...record({ chain: [] }),
      provider,
      accountHome: {
        variable: provider === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME',
        path: '/accounts/a'
      },
      options: { permissionMode: 'auto' }
    }
    const deps = {
      store: { getRecord: () => saved, pinLaunchDirectory: vi.fn() },
      agents: {
        definition: () => (provider === 'claude' ? CLAUDE_STRUCTURED_AGENT : CODEX_STRUCTURED_AGENT)
      }
    }
    const read = await readStructuredAgentSessionOptionsAtRest(deps, saved.sessionId)
    expect(read.permissionModes?.current).toBe('auto')
    expect(read.permissionModes?.supported).toContain('auto')
    expect(parseAgentSessionPermissionModes(read.permissionModes)).toEqual(read.permissionModes)
    const picked = await recordStructuredAgentSessionOptionIntent(
      deps,
      {
        sessionId: saved.sessionId,
        publish: vi.fn(),
        persistOptions: async (options: Readonly<Record<string, string>>) => {
          saved.options = { permissionMode: options.permissionMode }
        }
      },
      { key: 'permissionMode', value: 'ask' }
    )
    expect(picked.ok).toBe(true)
    const identity = {
      sessionId: saved.sessionId,
      workspaceId: saved.location.workspaceId,
      hostId: 'local',
      agent: provider,
      providerHandle: null
    }
    const launchDeps = {
      store: deps.store,
      resolveAuthPolicy: () => ({ stripAuthEnv: false }),
      resolveCommand: () => provider,
      resolveLaunchArgs: () => [],
      resolveWorkspacePath: async () => process.cwd()
    }
    if (provider === 'claude') {
      const launch = await createClaudeStructuredLaunchResolver(launchDeps)({ identity })
      const spawn = claudeStructuredSpawnOptions({ launch, saved: saved.options })
      expect(launch.permissionMode).toBe('ask')
      expect(spawn.sdkOptions.permissionMode).toBe('default')
      expect(spawn.sdkOptions.extraArgs).not.toHaveProperty('dangerously-skip-permissions')
    } else {
      const launch = await createCodexStructuredLaunchResolver(launchDeps)({ identity })
      const options = restoredCodexSessionOptions(saved.options)
      const applied = adoptCodexOpenedPermissionState(options, launch, {
        approvalsReviewerSupported: true
      })
      expect(launch.permissionPolicy).toMatchObject({
        approvalPolicy: 'on-request',
        approvalsReviewer: 'user'
      })
      expect(applied.threadPermissionMode).toBe('ask')
    }
    expect(saved.options.permissionMode).toBe('ask')
  }
)

it('derives a fixed mode from the legacy reviewer at rest', async () => {
  const saved = { ...record({ chain: [] }), options: { approvalsReviewer: 'user' } }
  const read = await readStructuredAgentSessionOptionsAtRest(
    {
      store: { getRecord: () => saved },
      agents: { definition: () => CODEX_STRUCTURED_AGENT }
    },
    saved.sessionId
  )
  expect(read.permissionModes?.current).toBe('ask')
})
