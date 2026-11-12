import { agentSessionRecordFixture } from '../../../native-chat/agent-session-record-test-fixture'
import { createClaudeStructuredLaunchResolver } from '../../../runtime/agent-session/launch/structured-agent-launch-composition.test-support'
import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import { claudeProviderHandle } from '../../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'
import { adapterFor, fakeClaude } from '../claude-structured-session-test-support'

const ADVISORY = {
  schema: 1 as const,
  dataScope: 'published' as const,
  sourcePin: 'a'.repeat(40),
  deadlineAt: 1_800_000_300_000,
  maxModelCalls: 4,
  artifacts: [
    {
      path: 'note.txt',
      text: 'hello',
      sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'
    }
  ]
}

const SESSION_ID = 'orca-session-1'
const IDENTITY = { sessionId: SESSION_ID } as Parameters<
  ReturnType<typeof createClaudeStructuredLaunchResolver>
>[0]['identity']

function record(overrides: Partial<AgentSessionRecord> = {}): AgentSessionRecord {
  return agentSessionRecordFixture({
    sessionId: SESSION_ID,
    provider: 'claude',
    location: {
      executionHostId: LOCAL_EXECUTION_HOST_ID,
      wslDistro: null,
      workspaceId: 'workspace-1',
      workspaceKind: 'folder'
    },
    accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: '/home/work/.claude' },
    providerHandleChain: [],
    ...overrides
  })
}

function identityAt(leafUuid: string | null): typeof IDENTITY {
  return {
    ...IDENTITY,
    providerHandle: claudeProviderHandle('provider-current', leafUuid)
  }
}

function resolverFor(
  value: AgentSessionRecord | null,
  resolveEnv?: () => Record<string, string>,
  account: 'managed' | 'system' = 'system',
  hasTranscript: () => Promise<boolean> = async () => true,
  resolveLaunchArgs?: () => string[],
  attachmentDirectory?: string
) {
  return createClaudeStructuredLaunchResolver({
    store: { getRecord: () => value, pinLaunchDirectory: vi.fn() },
    resolveWorkspacePath: async (id) => `/repos/${id}`,
    resolveCommand: () => ({ command: '/usr/local/bin/claude', prefixArgs: [] }),
    resolveAuthPolicy: () => ({ account }),
    hasTranscript,
    resolveLaunchArgs: resolveLaunchArgs ?? (() => value?.launchArgs ?? []),
    ...(resolveEnv ? { resolveEnv } : {}),
    ...(attachmentDirectory ? { attachmentDirectory } : {})
  })
}

const RESUMABLE = record({
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the resolver reads only each link's handle, so the link's other fields stay unset.
  providerHandleChain: [
    { handle: claudeProviderHandle('provider-current', 'leaf-current') }
  ] as AgentSessionRecord['providerHandleChain']
})

describe('claude structured launch resolution', () => {
  it('carries an immutable advisory snapshot through composed launch and acquisition', async () => {
    const saved = record({ schemaVersion: 3, advisoryPolicy: structuredClone(ADVISORY) })
    const launch = await resolverFor(saved)({ identity: IDENTITY })
    expect(launch.advisoryPolicy).toMatchObject({
      sourcePin: 'a'.repeat(40),
      artifacts: [{ text: 'hello' }]
    })
    saved.advisoryPolicy!.artifacts[0]!.text = 'changed after resolution'
    const claude = fakeClaude({ initSessionId: launch.providerSessionId })
    try {
      const adapter = adapterFor(claude, launch)
      await adapter.acquire({
        identity: {
          sessionId: SESSION_ID,
          workspaceId: 'workspace-1',
          hostId: LOCAL_EXECUTION_HOST_ID,
          agent: 'claude',
          providerHandle: null
        },
        fence: 1,
        spawnToken: 'advisor-spawn'
      })
      expect(claude.connections[0]!.launch.advisoryPolicy).toMatchObject({
        maxModelCalls: 4,
        artifacts: [{ text: 'hello' }]
      })
    } finally {
      claude.dispose()
    }
  })

  it('refuses a bounded launch that would reuse saved provider context', async () => {
    const saved = { ...RESUMABLE, schemaVersion: 3 as const, advisoryPolicy: ADVISORY }
    let failure: string | undefined
    try {
      await resolverFor(saved)({ identity: identityAt('leaf-current') })
    } catch (error) {
      failure = error instanceof Error ? error.message : 'unexpected error'
    }
    expect(failure).toBe('Advisor requires a fresh folder conversation.')
  })

  it('launches when only the bookkeeping leaf moved, and refuses a changed session', async () => {
    const resolve = resolverFor(RESUMABLE)

    // A failed turn-end or exit write leaves the identity's leaf behind the record's.
    await expect(resolve({ identity: identityAt('leaf-stale') })).resolves.toMatchObject({
      providerSessionId: 'provider-current',
      resumeLeafUuid: 'leaf-current'
    })
    await expect(
      resolve({
        identity: {
          ...IDENTITY,
          providerHandle: claudeProviderHandle('provider-other', 'leaf-current')
        }
      })
    ).rejects.toThrow('durable resume identity changed before spawn')
  })
})
