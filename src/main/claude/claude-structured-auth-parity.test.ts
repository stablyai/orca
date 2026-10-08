import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import { CLAUDE_AUTH_ENV_CONFLICT_MESSAGE } from '../claude-accounts/environment'
import { createClaudeStructuredLaunchResolver } from './claude-structured-launch-resolution'

const SESSION_ID = 'orca-session-auth'
const IDENTITY = { sessionId: SESSION_ID } as Parameters<
  ReturnType<typeof createClaudeStructuredLaunchResolver>
>[0]['identity']

function record(): AgentSessionRecord {
  return {
    sessionId: SESSION_ID,
    provider: 'claude',
    location: {
      executionHostId: LOCAL_EXECUTION_HOST_ID,
      wslDistro: null,
      workspaceId: 'workspace-1',
      workspaceKind: 'folder'
    },
    accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: '/home/work/.claude' },
    providerHandleChain: []
  } as unknown as AgentSessionRecord
}

function resolverFor(options: {
  stripAuthEnv: boolean
  overlay?: Record<string, string>
}): ReturnType<typeof createClaudeStructuredLaunchResolver> {
  return createClaudeStructuredLaunchResolver({
    resolveLaunchArgs: () => [],
    store: { getRecord: () => record(), pinLaunchDirectory: vi.fn() },
    resolveWorkspacePath: async (id) => `/repos/${id}`,
    resolveCommand: () => '/usr/local/bin/claude',
    resolveAuthPolicy: () => ({ stripAuthEnv: options.stripAuthEnv }),
    ...(options.overlay ? { resolveEnv: () => options.overlay as Record<string, string> } : {})
  })
}

function withAmbientAuth<T>(value: string, run: () => Promise<T>): Promise<T> {
  const restore = process.env.ANTHROPIC_API_KEY
  process.env.ANTHROPIC_API_KEY = value
  return run().finally(() => {
    if (restore === undefined) {
      delete process.env.ANTHROPIC_API_KEY
    } else {
      process.env.ANTHROPIC_API_KEY = restore
    }
  })
}

describe('claude structured auth parity with the terminal preflight', () => {
  // Task 1 — the terminal preflight refuses this at spawn-env.ts:25 and
  // runtime/spawn-preflight.ts:139; the structured path used to let the override win.
  it('refuses an explicit Anthropic auth override while a managed account is pinned', async () => {
    await expect(
      resolverFor({ stripAuthEnv: true, overlay: { ANTHROPIC_API_KEY: 'sk-ant-CONFIGURED' } })({
        identity: IDENTITY
      })
    ).rejects.toMatchObject({
      message: CLAUDE_AUTH_ENV_CONFLICT_MESSAGE,
      reason: 'managedAccountEnvOverride'
    })
  })

  it('refuses an auth-like ANTHROPIC_CUSTOM_HEADERS override while a managed account is pinned', async () => {
    await expect(
      resolverFor({
        stripAuthEnv: true,
        overlay: { ANTHROPIC_CUSTOM_HEADERS: 'Authorization: Bearer sk-ant-CONFIGURED' }
      })({ identity: IDENTITY })
    ).rejects.toMatchObject({
      message: CLAUDE_AUTH_ENV_CONFLICT_MESSAGE,
      reason: 'managedAccountEnvOverride'
    })
  })

  it('still admits a non-auth env overlay under a managed account', async () => {
    const launch = await resolverFor({
      stripAuthEnv: true,
      overlay: { ANTHROPIC_BASE_URL: 'https://gateway.example.test' }
    })({ identity: IDENTITY })

    expect(launch.env?.ANTHROPIC_BASE_URL).toBe('https://gateway.example.test')
  })

  // Task 2 — legacy computes stripAuthEnv at runtime-auth-preparation.ts:72, so a
  // system-auth user's own shell key is their sign-in and must survive.
  it('passes an ambient Anthropic key through when no managed account is active', async () => {
    await withAmbientAuth('sk-ant-SHELL', async () => {
      const launch = await resolverFor({ stripAuthEnv: false })({ identity: IDENTITY })

      expect(launch.env?.ANTHROPIC_API_KEY).toBe('sk-ant-SHELL')
    })
  })

  it('lets an explicit overlay override the ambient key when no managed account is active', async () => {
    await withAmbientAuth('sk-ant-SHELL', async () => {
      const launch = await resolverFor({
        stripAuthEnv: false,
        overlay: { ANTHROPIC_API_KEY: 'sk-ant-CONFIGURED' }
      })({ identity: IDENTITY })

      expect(launch.env?.ANTHROPIC_API_KEY).toBe('sk-ant-CONFIGURED')
    })
  })

  it('still strips the ambient Anthropic key when a managed account is pinned', async () => {
    await withAmbientAuth('sk-ant-SHELL', async () => {
      const launch = await resolverFor({ stripAuthEnv: true })({ identity: IDENTITY })

      expect(launch.env?.ANTHROPIC_API_KEY).toBeUndefined()
    })
  })
})
