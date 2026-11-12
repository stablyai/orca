import { expect, it } from 'vitest'
import { StructuredAgentSessionInputNotAdmitted } from '../../../native-chat/agent-session-wire/delivery/structured-agent-session-input-admission'
import {
  acquireReadyCodexForTest,
  adapterFor,
  fakeCodex,
  identityFor,
  THREAD_ID
} from '../session-lifecycle/codex-structured-session-adapter-fixture'

async function bounded(account: unknown) {
  const codex = fakeCodex({
    'config/read': () => ({ config: {}, layers: [] }),
    'mcpServerStatus/list': () => ({ data: [], nextCursor: null }),
    'account/read': () => ({ account }),
    'thread/start': () => ({
      thread: { id: THREAD_ID, modelProvider: 'openai' },
      cwd: '/work/repo',
      model: 'gpt-live',
      reasoningEffort: 'low',
      serviceTier: 'default',
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      activePermissionProfile: { id: 'bounded-profile' },
      runtimeWorkspaceRoots: ['/work/repo'],
      sandbox: { type: 'readOnly', networkAccess: false }
    })
  })
  const adapter = adapterFor(codex, {
    execution: {
      profileId: 'bounded-profile',
      policy: {
        schema: 1,
        sourcePin: 'a'.repeat(40),
        accountFingerprint:
          'codex:07e998012c1137decdf3efbbb1c3ee6d79b015638cbc197bdbcce1875de4faad',
        model: 'gpt-live',
        effort: 'low',
        deadlineAt: Date.now() + 120_000,
        access: 'read-only'
      }
    }
  })
  await acquireReadyCodexForTest(adapter, {
    identity: identityFor('session-1'),
    fence: 7,
    spawnToken: 'spawn-1',
    permissionMode: 'own',
    options: { model: 'gpt-live', effort: 'low' }
  })
  return { adapter, codex }
}

const input = {
  sessionId: 'session-1',
  clientMessageId: 'bounded-input',
  fence: 7,
  body: {
    kind: 'message' as const,
    role: 'user' as const,
    blocks: [{ type: 'text' as const, text: 'Read the admitted file and report the result.' }]
  }
}

it.each([{ type: 'apiKey' }, { type: 'chatgpt', id: 'wrong-account', planType: 'pro' }, null])(
  'refuses input when the held account is not the admitted included account: %j',
  async (account) => {
    const { adapter } = await bounded(account)
    try {
      await expect(adapter.dispatch(input)).rejects.toBeInstanceOf(
        StructuredAgentSessionInputNotAdmitted
      )
    } finally {
      await adapter.closeAll()
    }
  }
)

it('preserves the native named profile on the one admitted input and refuses another input', async () => {
  const { adapter, codex } = await bounded({ type: 'chatgpt', id: 'account-1', planType: 'pro' })
  try {
    await expect(adapter.dispatch(input)).resolves.toMatchObject({ state: 'admitted' })
    const request = codex.connections[0]!.calls.find((call) => call.method === 'turn/start')?.params
    expect(request).toMatchObject({
      permissions: 'bounded-profile',
      runtimeWorkspaceRoots: ['/work/repo'],
      model: 'gpt-live',
      effort: 'low',
      approvalPolicy: 'never',
      approvalsReviewer: 'user'
    })
    expect(request).not.toHaveProperty('sandboxPolicy')
    await expect(
      adapter.dispatch({ ...input, clientMessageId: 'second-input' })
    ).rejects.toBeInstanceOf(StructuredAgentSessionInputNotAdmitted)
  } finally {
    await adapter.closeAll()
  }
})

it('retains the reported opening roots and stops a bounded child on native settings drift', async () => {
  const { adapter, codex } = await bounded({ type: 'chatgpt', id: 'account-1', planType: 'pro' })
  try {
    await adapter.dispatch(input)
    const threadSettings = {
      cwd: '/work/repo',
      modelProvider: 'openai',
      model: 'gpt-live',
      effort: 'low',
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      activePermissionProfile: { id: 'bounded-profile' },
      sandboxPolicy: { type: 'readOnly', networkAccess: false }
    }
    codex.connections[0]!.handlers.onNotification?.('thread/settings/updated', {
      threadId: THREAD_ID,
      threadSettings
    })
    const captured = await adapter.readExecutionEvidence({ sessionId: 'session-1', fence: 7 })
    expect(captured?.evidence).toMatchObject({
      runtimeWorkspaceRoots: ['/work/repo'],
      bounded: { toolsIsolated: true, inputAdmitted: true, workspaceRootsSource: 'thread-open' }
    })
    codex.connections[0]!.handlers.onNotification?.('thread/settings/updated', {
      threadId: THREAD_ID,
      threadSettings: { ...threadSettings, model: 'gpt-other' }
    })
    expect(codex.connections[0]!.closed).toBe(true)
  } finally {
    await adapter.closeAll()
  }
})
