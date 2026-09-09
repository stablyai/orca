import { chmodSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import { CLAUDE_AUTH_ENV_CONFLICT_MESSAGE } from '../claude-accounts/environment'
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

function makeExecutable(path: string): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, '')
  if (process.platform !== 'win32') {
    chmodSync(path, 0o755)
  }
}

describe('Claude TUI resume launch', () => {
  it('pins the workspace, account home, setting sources, and launch identity', async () => {
    const build = createClaudeTuiResumeLaunchBuilder({
      resolveWorkspacePath: async (workspaceId) => `/workspaces/${workspaceId}`,
      resolveCommand: () => '/usr/local/bin/claude',
      resolveAuthPolicy: () => ({ stripAuthEnv: false }),
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
    // System auth (the only state an explicit ANTHROPIC_AUTH_TOKEN overlay is legal in):
    // the user's own inherited key is their sign-in and survives. The managed-account
    // half — where it is stripped — is covered by 'structured-to-TUI handoff auth'.
    expect(launch.env.ANTHROPIC_API_KEY).toBe('inherited-gateway-key')
    // Endpoint selection is not credential material; the existing adapter pinning preserves it.
    expect(launch.env.ANTHROPIC_BASE_URL).toBe('https://inherited-gateway.invalid')
    expect(launch.env.CLAUDE_CODE_SESSION_ID).toBeUndefined()
  })

  it('pairs the resumed Claude CLI with its sibling Node runtime', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-claude-resume-'))
    const binDir = join(root, 'bin')
    const claudeCommand = join(binDir, process.platform === 'win32' ? 'claude.cmd' : 'claude')
    const nodeCommand = join(binDir, process.platform === 'win32' ? 'node.cmd' : 'node')
    makeExecutable(claudeCommand)
    makeExecutable(nodeCommand)

    const build = createClaudeTuiResumeLaunchBuilder({
      resolveWorkspacePath: async () => '/workspace',
      resolveCommand: () => claudeCommand,
      resolveAuthPolicy: () => ({ stripAuthEnv: true }),
      resolveEnv: () => ({ PATH: '/usr/bin' }),
      inheritedEnv: {}
    })

    const launch = await build({ record: record(), spawnToken: 'spawn' })

    expect((launch.env.PATH ?? launch.env.Path)?.split(delimiter)[0]).toBe(binDir)
  })

  it('uses the durable session environment instead of current account settings', async () => {
    const build = createClaudeTuiResumeLaunchBuilder({
      resolveWorkspacePath: async () => '/workspace',
      resolveCommand: () => 'claude',
      resolveAuthPolicy: () => ({ stripAuthEnv: false }),
      resolveEnv: () => ({ ANTHROPIC_AUTH_TOKEN: 'pinned-token' }),
      inheritedEnv: {}
    })

    const launch = await build({ record: record(), spawnToken: 'spawn' })

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
      resolveAuthPolicy: () => ({ stripAuthEnv: true }),
      inheritedEnv: {}
    })

    await expect(build({ record: nextRecord, spawnToken: 'spawn-two' })).resolves.toMatchObject({
      providerSessionId: 'provider-session',
      resumeLeafUuid: 'leaf-two'
    })
  })

  it('preserves durable Claude launch arguments before resume defaults', async () => {
    const build = createClaudeTuiResumeLaunchBuilder({
      resolveWorkspacePath: async () => '/workspace',
      resolveCommand: () => 'claude',
      resolveAuthPolicy: () => ({ stripAuthEnv: true }),
      inheritedEnv: {}
    })

    const launch = await build({
      record: record({ launchArgs: ['--model', 'claude-sonnet-4-5'] }),
      spawnToken: 'spawn'
    })

    expect(launch.args.slice(0, 3)).toEqual(['--model', 'claude-sonnet-4-5', '--setting-sources'])
  })

  it('rejects missing Claude handles and unpinned account homes', async () => {
    const build = createClaudeTuiResumeLaunchBuilder({
      resolveWorkspacePath: async () => '/workspace',
      resolveCommand: () => 'claude',
      resolveAuthPolicy: () => ({ stripAuthEnv: true }),
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

// buildClaudeChildProcessEnv strips its inherited half unconditionally, so this module
// would have signed a system-auth user out of the session the structured path had just
// honoured. It is not wired up yet; the required policy is what stops the next caller
// from inheriting that.
describe('structured-to-TUI handoff auth', () => {
  it('carries a system-auth user their own inherited credential', async () => {
    const launch = await createClaudeTuiResumeLaunchBuilder({
      resolveWorkspacePath: async () => '/repos/workspace-1',
      resolveCommand: () => '/usr/local/bin/claude',
      resolveAuthPolicy: () => ({ stripAuthEnv: false }),
      inheritedEnv: { ANTHROPIC_API_KEY: 'sk-ant-SHELL', PATH: '/usr/bin' }
    })({ record: record(), spawnToken: 'token-1' })

    expect(launch.env.ANTHROPIC_API_KEY).toBe('sk-ant-SHELL')
  })

  it('still strips it once a managed account owns the credential', async () => {
    const launch = await createClaudeTuiResumeLaunchBuilder({
      resolveWorkspacePath: async () => '/repos/workspace-1',
      resolveCommand: () => '/usr/local/bin/claude',
      resolveAuthPolicy: () => ({ stripAuthEnv: true }),
      inheritedEnv: { ANTHROPIC_API_KEY: 'sk-ant-SHELL', PATH: '/usr/bin' }
    })({ record: record(), spawnToken: 'token-1' })

    expect(launch.env.ANTHROPIC_API_KEY).toBeUndefined()
  })

  it('refuses a configured override of a pinned managed account, as the terminal path does', async () => {
    await expect(
      createClaudeTuiResumeLaunchBuilder({
        resolveWorkspacePath: async () => '/repos/workspace-1',
        resolveCommand: () => '/usr/local/bin/claude',
        resolveAuthPolicy: () => ({ stripAuthEnv: true }),
        resolveEnv: () => ({ ANTHROPIC_API_KEY: 'sk-ant-CONFIGURED' }),
        inheritedEnv: {}
      })({ record: record(), spawnToken: 'token-1' })
    ).rejects.toThrow(CLAUDE_AUTH_ENV_CONFLICT_MESSAGE)
  })
})
