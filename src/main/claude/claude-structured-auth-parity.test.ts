import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
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
  account: 'managed' | 'system'
  overlay?: Record<string, string>
}): ReturnType<typeof createClaudeStructuredLaunchResolver> {
  return createClaudeStructuredLaunchResolver({
    resolveLaunchArgs: () => [],
    store: { getRecord: () => record(), pinLaunchDirectory: vi.fn() },
    resolveWorkspacePath: async (id) => `/repos/${id}`,
    resolveCommand: () => '/usr/local/bin/claude',
    resolveAuthPolicy: () => ({ account: options.account }),
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
  // Like terminals, a chat keeps the shell's Anthropic auth on every account: a proxy's key must
  // travel with its ANTHROPIC_BASE_URL.
  for (const account of ['managed', 'system'] as const) {
    it(`passes an ambient Anthropic key through on a ${account} account`, async () => {
      await withAmbientAuth('sk-ant-SHELL', async () => {
        const launch = await resolverFor({ account })({ identity: IDENTITY })

        expect(launch.env?.ANTHROPIC_API_KEY).toBe('sk-ant-SHELL')
        expect(launch.account).toBe(account)
      })
    })

    it(`lets an explicit auth overlay through on a ${account} account`, async () => {
      await withAmbientAuth('sk-ant-SHELL', async () => {
        const launch = await resolverFor({
          account,
          overlay: {
            ANTHROPIC_API_KEY: 'sk-ant-CONFIGURED',
            ANTHROPIC_BASE_URL: 'https://gateway.example.test'
          }
        })({ identity: IDENTITY })

        expect(launch.env?.ANTHROPIC_API_KEY).toBe('sk-ant-CONFIGURED')
        expect(launch.env?.ANTHROPIC_BASE_URL).toBe('https://gateway.example.test')
      })
    })
  }
})
