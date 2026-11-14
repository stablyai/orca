import { expect, it, vi } from 'vitest'
import { openCodexThread } from '../threads/codex-structured-thread-open'
import { agentSessionRecordFixture } from '../../../native-chat/testing/agent-session-record-test-fixture'
import { createCodexStructuredLaunchResolver } from '../../../runtime/agent-session/launch/structured-agent-launch-composition.test-support'
import {
  fakeCodex,
  adapterFor,
  acquireReadyCodexForTest,
  identityFor
} from '../session-lifecycle/codex-structured-session-adapter-fixture'

vi.mock('./codex-execution-executable', () => ({
  readCodexExecutionExecutable: vi
    .fn()
    .mockResolvedValue({ path: '/native/codex', sha256: 'c'.repeat(64), version: '0.167.2' })
}))

function resolve(
  deadlineAt = Date.now() + 120_000,
  prepareLaunchAccountHome?: () => Promise<null>
) {
  const record = agentSessionRecordFixture({
    sessionId: 'session-bounded',
    provider: 'codex',
    schemaVersion: 4,
    location: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'folder-one',
      workspaceKind: 'folder'
    },
    accountHome: { variable: 'CODEX_HOME', path: '/account' },
    permissionMode: 'full-access',
    options: { model: 'gpt-live', effort: 'low' },
    providerHandleChain: [],
    executionPolicy: {
      schema: 1,
      sourcePin: 'a'.repeat(40),
      accountFingerprint: `codex:${'b'.repeat(64)}`,
      model: 'gpt-live',
      effort: 'low',
      access: 'workspace',
      deadlineAt
    }
  })
  return createCodexStructuredLaunchResolver({
    store: { getRecord: () => record, pinLaunchDirectory: vi.fn() },
    resolveWorkspacePath: async () => '/work/repo',
    resolveCommand: () => ({ command: 'codex', prefixArgs: [] }),
    ...(prepareLaunchAccountHome ? { prepareLaunchAccountHome } : {}),
    resolveLaunchArgs: () => [
      '--dangerously-bypass-approvals-and-sandbox',
      '-c',
      'model_provider="custom"'
    ]
  })({
    identity: identityFor('session-bounded')
  })
}

it('pins included Codex inference settings instead of inheriting privileged user launch flags', async () => {
  const launch = await resolve()
  expect(launch.args).not.toContain('--dangerously-bypass-approvals-and-sandbox')
  expect(launch.args).not.toContain('model_provider="custom"')
  expect(launch.args).toContain('forced_login_method="chatgpt"')
  expect(launch.args).toContain('openai_base_url="https://chatgpt.com/backend-api/codex"')
  expect(launch.args).toContain('model_reasoning_effort="low"')
  expect(launch.args).toContain('features.multi_agent=false')
  expect(launch.args).toContain('projects={"/work/repo"={trust_level="untrusted"}}')
  expect(launch.envToDelete).toEqual(
    expect.arrayContaining(['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL'])
  )
  expect(launch.permissionPolicy).toBeUndefined()
})

it('launches the recorded bounded account without mutable account-home preparation', async () => {
  const launch = await resolve(undefined, async () => {
    throw new Error('Mutable account-home preparation must not run.')
  })
  expect(launch.codexHome).toBe('/account')
})

it('refuses an expired bounded launch before acquiring a native child', async () => {
  await expect(resolve(Date.now() - 1)).rejects.toThrow('bounded Codex')
})

it('opens a bounded thread with its named profile, one root and no provider fallback', async () => {
  const codex = fakeCodex({
    'config/read': () => ({
      config: {
        features: { memories: false, memory_tool: false },
        memories: { generate_memories: false, use_memories: false }
      },
      layers: []
    }),
    'mcpServerStatus/list': () => ({ data: [], nextCursor: null })
  })
  const adapter = adapterFor(codex, await resolve())
  try {
    await acquireReadyCodexForTest(adapter, {
      identity: identityFor('session-bounded'),
      fence: 7,
      spawnToken: 'spawn-bounded'
    })
    const request = codex.connections[0]!.calls.find(
      (call) => call.method === 'thread/start'
    )?.params
    expect(request).toMatchObject({
      permissions: 'orca-bounded-session-bounded',
      runtimeWorkspaceRoots: ['/work/repo'],
      allowProviderModelFallback: false,
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      modelProvider: 'openai'
    })
    expect(request).not.toHaveProperty('sandbox')
  } finally {
    await adapter.closeAll()
  }
})

it.each([
  {},
  { features: { memories: true, memory_tool: false } },
  { features: { memories: false, memory_tool: true } },
  {
    features: { memories: false, memory_tool: false },
    memories: { generate_memories: true, use_memories: false }
  },
  {
    features: { memories: false, memory_tool: false },
    memories: { generate_memories: false, use_memories: true }
  }
])('refuses a bounded thread with unproven memory isolation: %j', async (config) => {
  await expect(
    openCodexThread(
      {
        request: async (method) => {
          if (method === 'config/read') {
            return { config, layers: [] }
          }
          throw new Error('Unisolated thread was opened.')
        }
      },
      { cwd: '/work/repo', resumeThreadId: null, execution: { profileId: 'bounded-profile' } },
      2_000
    )
  ).rejects.toThrow('Bounded Codex memory isolation unavailable.')
})

it('ends an owned child at the deadline even before the thread opens', async () => {
  vi.useFakeTimers()
  const codex = fakeCodex()
  const adapter = adapterFor(codex, await resolve())
  try {
    await adapter.acquire({
      identity: identityFor('session-bounded'),
      fence: 7,
      spawnToken: 'spawn-bounded'
    })
    await vi.advanceTimersByTimeAsync(120_000)
    expect(codex.connections[0]!.closed).toBe(true)
  } finally {
    await adapter.closeAll()
    vi.useRealTimers()
  }
})
