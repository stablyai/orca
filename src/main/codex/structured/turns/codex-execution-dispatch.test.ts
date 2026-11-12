import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { CodexStructuredSessionEvent } from '../session-lifecycle/codex-structured-session-state'
import type { AgentSessionExecutionReceiptWrite } from '../../../../shared/agent-session/agent-session-execution-receipt'
import { StructuredAgentSessionInputNotAdmitted } from '../../../native-chat/agent-session-wire/delivery/structured-agent-session-input-admission'
import {
  acquireReadyCodexForTest,
  adapterFor,
  fakeCodex,
  identityFor,
  THREAD_ID
} from '../session-lifecycle/codex-structured-session-adapter-fixture'

vi.mock('./codex-execution-source', () => ({
  assertCodexExecutionSource: vi.fn().mockResolvedValue(undefined)
}))

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(1_800_000_000_000)
})
afterEach(() => vi.useRealTimers())

async function bounded(account: unknown, initialAccountUpdate = false) {
  const receipts: AgentSessionExecutionReceiptWrite[] = []
  const reports: unknown[] = []
  const events: CodexStructuredSessionEvent[] = []
  const codex = fakeCodex({
    'account/rateLimits/read': () => ({
      rateLimits: { primary: { usedPercent: 20, resetsAt: 1_800_001_000 } }
    }),
    'model/list': () => ({
      data: [{ model: 'gpt-live', supportedReasoningEfforts: [{ reasoningEffort: 'low' }] }],
      nextCursor: null
    }),
    'config/read': () => ({ config: {}, layers: [] }),
    'mcpServerStatus/list': () => ({ data: [], nextCursor: null }),
    'account/read': () => {
      if (initialAccountUpdate) {
        initialAccountUpdate = false
        codex.connections[0]!.handlers.onNotification?.('account/updated', { authMode: 'chatgpt' })
      }
      return { account }
    },
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
  const adapter = adapterFor(
    codex,
    {
      execution: {
        profileId: 'bounded-profile',
        policy: {
          schema: 1,
          sourcePin: 'a'.repeat(40),
          accountFingerprint:
            'codex:07e998012c1137decdf3efbbb1c3ee6d79b015638cbc197bdbcce1875de4faad',
          model: 'gpt-live',
          effort: 'low',
          deadlineAt: 1_800_000_120_000,
          access: 'read-only'
        }
      }
    },
    events,
    {
      onExecutionReceipt: async (write) => {
        receipts.push(structuredClone(write))
      },
      prepareExecutionReporter: () => async (report) => {
        reports.push(report)
      }
    }
  )
  await acquireReadyCodexForTest(adapter, {
    identity: identityFor('session-1'),
    fence: 7,
    spawnToken: 'spawn-1',
    permissionMode: 'own',
    options: { model: 'gpt-live', effort: 'low' }
  })
  return { adapter, codex, receipts, reports, events }
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

it('admits the first bounded input after the initial account notification settles', async () => {
  const { adapter } = await bounded({ type: 'chatgpt', id: 'account-1', planType: 'pro' }, true)
  try {
    await expect(adapter.dispatch(input)).resolves.toMatchObject({ state: 'admitted' })
  } finally {
    await adapter.closeAll()
  }
})

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

it('preserves a generation-bound native execution and final usage receipt after physical stop', async () => {
  const { adapter, codex, receipts } = await bounded({
    type: 'chatgpt',
    id: 'account-1',
    planType: 'pro'
  })
  await adapter.dispatch(input)
  codex.connections[0]!.handlers.onNotification?.('thread/tokenUsage/updated', {
    threadId: THREAD_ID,
    tokenUsage: {
      total: {
        totalTokens: 99,
        inputTokens: 80,
        cachedInputTokens: 32,
        outputTokens: 19,
        reasoningOutputTokens: 12
      }
    }
  })
  codex.connections[0]!.handlers.onNotification?.('turn/completed', {
    threadId: THREAD_ID,
    turn: { id: 'turn-1', status: 'completed' }
  })
  await adapter.closeAll()
  expect(receipts.at(-1)).toMatchObject({
    sessionId: 'session-1',
    fence: 7,
    generation: 'generation-1',
    receipt: {
      turnCompleted: true,
      invalidated: false,
      execution: { usage: { totalTokens: 99, reasoningOutputTokens: 12 } },
      closure: { root: 'exited', tree: 'exited' }
    }
  })
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

it('reports cumulative primary-thread usage and never substitutes last-context or another thread', async () => {
  const { adapter, codex } = await bounded({ type: 'chatgpt', id: 'account-1', planType: 'pro' })
  try {
    await adapter.dispatch(input)
    const total = {
      totalTokens: 99,
      inputTokens: 80,
      cachedInputTokens: 32,
      outputTokens: 19,
      reasoningOutputTokens: 12
    }
    const update = (threadId: string, value: unknown) =>
      codex.connections[0]!.handlers.onNotification?.('thread/tokenUsage/updated', {
        threadId,
        tokenUsage: { total: value, last: { totalTokens: 7 }, modelContextWindow: 1000 }
      })
    update(THREAD_ID, total)
    update('foreign-thread', { ...total, totalTokens: 999 })
    const captured = await adapter.readExecutionEvidence({ sessionId: 'session-1', fence: 7 })
    expect(captured?.evidence).toMatchObject({
      usage: { ...total, threadId: THREAD_ID, observedAt: 1_700_000_000_500 }
    })
    update(THREAD_ID, { ...total, totalTokens: 90 })
    expect(
      (await adapter.readExecutionEvidence({ sessionId: 'session-1', fence: 7 }))?.evidence
    ).not.toHaveProperty('usage')
  } finally {
    await adapter.closeAll()
  }
})

it('offers only a host-bound one-shot report tool and refuses foreign thread calls', async () => {
  const { adapter, codex, reports } = await bounded({
    type: 'chatgpt',
    id: 'account-1',
    planType: 'pro'
  })
  try {
    await adapter.dispatch(input)
    expect(
      codex.connections[0]!.calls.find((call) => call.method === 'thread/start')?.params
    ).toMatchObject({
      dynamicTools: [{ type: 'function', name: 'orca_worker_report' }]
    })
    const report = { status: 'succeeded', summary: 'The admitted task passed its checks.' }
    const call = (id: number, threadId: string) =>
      codex.connections[0]!.handlers.onServerRequest?.({
        id,
        method: 'item/tool/call',
        params: {
          threadId,
          turnId: 'turn-1',
          callId: `call-${id}`,
          tool: 'orca_worker_report',
          arguments: report
        }
      })
    call(1, 'foreign-thread')
    await vi.waitFor(() =>
      expect(codex.connections[0]!.replies).toContainEqual({
        id: 1,
        result: { contentItems: [], success: false }
      })
    )
    expect(reports).toEqual([])
    call(2, THREAD_ID)
    await vi.waitFor(() => expect(reports).toEqual([report]))
    await vi.waitFor(() =>
      expect(codex.connections[0]!.replies).toContainEqual({
        id: 2,
        result: { contentItems: [], success: true }
      })
    )
    call(3, THREAD_ID)
    await vi.waitFor(() =>
      expect(codex.connections[0]!.replies).toContainEqual({
        id: 3,
        result: { contentItems: [], success: false }
      })
    )
    expect(reports).toEqual([report])
  } finally {
    await adapter.closeAll()
  }
})

it.each(['exhausted', 'unknown', 'wrong-model'] as const)(
  'refuses inference with %s capacity or catalog metadata',
  async (reason) => {
    const { adapter, codex } = await bounded({ type: 'chatgpt', id: 'account-1', planType: 'pro' })
    if (reason !== 'wrong-model') {
      codex.routes['account/rateLimits/read'] = () =>
        reason === 'unknown'
          ? {}
          : { rateLimits: { primary: { usedPercent: 100, resetsAt: 1_800_001_000 } } }
    } else {
      codex.routes['model/list'] = () => ({
        data: [{ model: 'foreign', supportedReasoningEfforts: [{ reasoningEffort: 'low' }] }],
        nextCursor: null
      })
    }
    try {
      await expect(adapter.dispatch(input)).rejects.toBeInstanceOf(
        StructuredAgentSessionInputNotAdmitted
      )
      expect(codex.connections[0]!.calls.some((call) => call.method === 'turn/start')).toBe(false)
    } finally {
      await adapter.closeAll()
    }
  }
)

it('closes a completed bounded turn as requested rather than recording a deadline fault', async () => {
  const { adapter, codex, events } = await bounded({
    type: 'chatgpt',
    id: 'account-1',
    planType: 'pro'
  })
  try {
    await adapter.dispatch(input)
    codex.connections[0]!.handlers.onNotification?.('turn/completed', {
      threadId: THREAD_ID,
      turn: { id: 'turn-1', status: 'completed' }
    })
    await vi.waitFor(() =>
      expect(
        events.some(
          (event) => event.type === 'ended' && 'cause' in event && event.cause === 'requested-close'
        )
      ).toBe(true)
    )
    expect(
      events.some(
        (event) => 'reason' in event && event.reason === 'Bounded Codex deadline reached.'
      )
    ).toBe(false)
  } finally {
    await adapter.closeAll()
  }
})
