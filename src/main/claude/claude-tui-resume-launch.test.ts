import { describe, expect, it } from 'vitest'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import { CLAUDE_DEFAULT_SETTING_SOURCES } from './claude-structured-launch-resolution'
import { CLAUDE_SPAWN_TOKEN_ENV } from './claude-structured-owner-identity'
import { createClaudeTuiResumeLaunchBuilder } from './claude-tui-resume-launch'

function record(overrides: Partial<AgentSessionRecord> = {}): AgentSessionRecord {
  return {
    sessionId: 'orca-session-1',
    provider: 'claude',
    location: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'workspace-folder',
      workspaceKind: 'folder'
    },
    accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: '/accounts/claude-one' },
    providerHandleChain: [
      {
        linkId: 'created',
        handle: { provider: 'claude', sessionId: 'provider-session', leafUuid: 'leaf-one' },
        origin: 'created',
        mintedAtFence: 1,
        observedAt: 1
      }
    ],
    ...overrides
  } as AgentSessionRecord
}

describe('Claude TUI resume launch', () => {
  it('pins the workspace, account home, setting sources, and launch identity', async () => {
    const build = createClaudeTuiResumeLaunchBuilder({
      resolveWorkspacePath: async (workspaceId) => `/workspaces/${workspaceId}`,
      resolveCommand: () => '/usr/local/bin/claude',
      resolveEnv: () => ({
        SELECTED_ACCOUNT: 'one',
        ANTHROPIC_AUTH_TOKEN: 'selected-account-token'
      }),
      inheritedEnv: {
        ANTHROPIC_API_KEY: 'inherited-gateway-key',
        ANTHROPIC_BASE_URL: 'https://inherited-gateway.invalid',
        CLAUDE_CODE_SESSION_ID: 'parent-session',
        SAFE_PARENT: 'kept'
      }
    })

    const launch = await build({ record: record(), spawnToken: 'spawn-one' })

    expect(launch).toMatchObject({
      command: '/usr/local/bin/claude',
      args: [
        '--setting-sources',
        CLAUDE_DEFAULT_SETTING_SOURCES.join(','),
        '--resume',
        'provider-session'
      ],
      cwd: '/workspaces/workspace-folder',
      providerSessionId: 'provider-session',
      resumeLeafUuid: 'leaf-one'
    })
    expect(launch.env).toMatchObject({
      SAFE_PARENT: 'kept',
      SELECTED_ACCOUNT: 'one',
      CLAUDE_CONFIG_DIR: '/accounts/claude-one',
      ORCA_AGENT_LAUNCH_TOKEN: 'spawn-one',
      [CLAUDE_SPAWN_TOKEN_ENV]: 'spawn-one',
      ANTHROPIC_AUTH_TOKEN: 'selected-account-token'
    })
    expect(launch.env.ANTHROPIC_API_KEY).toBeUndefined()
    // Endpoint selection is not credential material; the existing adapter pinning preserves it.
    expect(launch.env.ANTHROPIC_BASE_URL).toBe('https://inherited-gateway.invalid')
    expect(launch.env.CLAUDE_CODE_SESSION_ID).toBeUndefined()
  })

  it('uses the durable session environment instead of current account settings', async () => {
    const build = createClaudeTuiResumeLaunchBuilder({
      resolveWorkspacePath: async () => '/workspace',
      resolveCommand: () => 'claude',
      resolveEnv: () => ({ ANTHROPIC_AUTH_TOKEN: 'rotated-token' }),
      inheritedEnv: {}
    })

    const launch = await build({
      record: record({ launchEnv: { ANTHROPIC_AUTH_TOKEN: 'pinned-token' } }),
      spawnToken: 'spawn'
    })

    expect(launch.env.ANTHROPIC_AUTH_TOKEN).toBe('pinned-token')
  })

  it('resolves the durable chain head instead of an earlier Claude leaf', async () => {
    const nextRecord = record({
      providerHandleChain: [
        ...record().providerHandleChain,
        {
          linkId: 'resumed',
          handle: { provider: 'claude', sessionId: 'provider-session', leafUuid: 'leaf-two' },
          origin: 'resumed',
          mintedAtFence: 2,
          observedAt: 2
        }
      ]
    })
    const build = createClaudeTuiResumeLaunchBuilder({
      resolveWorkspacePath: async () => '/workspace',
      resolveCommand: () => 'claude',
      inheritedEnv: {}
    })

    await expect(build({ record: nextRecord, spawnToken: 'spawn-two' })).resolves.toMatchObject({
      providerSessionId: 'provider-session',
      resumeLeafUuid: 'leaf-two'
    })
  })

  it('rejects missing Claude handles and unpinned account homes', async () => {
    const build = createClaudeTuiResumeLaunchBuilder({
      resolveWorkspacePath: async () => '/workspace',
      resolveCommand: () => 'claude',
      inheritedEnv: {}
    })

    await expect(
      build({ record: record({ providerHandleChain: [] }), spawnToken: 'spawn' })
    ).rejects.toThrow('claude_tui_resume_handle_required')
    await expect(
      build({
        record: record({ accountHome: { variable: 'CODEX_HOME', path: '/wrong' } }),
        spawnToken: 'spawn'
      })
    ).rejects.toThrow(/CLAUDE_CONFIG_DIR/)
  })
})
