import { expect, it } from 'vitest'
import {
  acquireReadyCodexForTest,
  adapterFor,
  fakeCodex,
  identityFor,
  THREAD_ID
} from './codex-structured-session-adapter-fixture'

async function executionFixture(
  account: unknown = {
    type: 'chatgpt',
    id: 'account-1',
    email: 'private@invalid.test',
    planType: 'pro'
  },
  modelProvider = 'openai'
) {
  const codex = fakeCodex({
    'account/read': () => ({ account }),
    'thread/start': () => ({
      thread: { id: THREAD_ID, modelProvider },
      cwd: '/work/effective',
      model: 'gpt-live',
      reasoningEffort: 'low',
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
      sandbox: {
        type: 'readOnly',
        networkAccess: false,
        access: {
          type: 'restricted',
          readableRoots: ['/work/effective'],
          includePlatformDefaults: true
        }
      }
    })
  })
  const adapter = adapterFor(codex)
  await acquireReadyCodexForTest(adapter, {
    identity: identityFor('session-1'),
    fence: 7,
    spawnToken: 'spawn-9'
  })
  return { codex, adapter }
}

it('reads execution facts from the held Codex connection without exporting account identity', async () => {
  const { adapter } = await executionFixture()
  try {
    const captured = await adapter.readExecutionEvidence({ sessionId: 'session-1', fence: 7 })
    const evidence = captured?.evidence
    expect(captured?.isCurrent()).toBe(true)
    expect(evidence).toMatchObject({
      version: 1,
      agent: 'codex',
      sessionId: 'session-1',
      runtimeFence: 7,
      acquisitionGeneration: 'generation-1',
      observedAt: 1_700_000_000_500,
      model: 'gpt-live',
      effort: 'low',
      cwd: '/work/effective',
      modelProvider: 'openai',
      account: {
        type: 'chatgpt',
        plan: 'pro',
        fingerprint: 'codex:07e998012c1137decdf3efbbb1c3ee6d79b015638cbc197bdbcce1875de4faad'
      },
      permissions: {
        approvalPolicy: 'on-request',
        approvalsReviewer: 'user',
        sandbox: { type: 'readOnly', networkAccess: false, readableRoots: ['/work/effective'] }
      }
    })
    expect(JSON.stringify(evidence)).not.toContain('private@invalid.test')
    expect(JSON.stringify(evidence)).not.toContain('account-1')
    expect(await adapter.readExecutionEvidence({ sessionId: 'session-1', fence: 8 })).toBeNull()
    await adapter.closeAll()
    expect(captured?.isCurrent()).toBe(false)
  } finally {
    await adapter.closeAll()
  }
})

it('refuses paid/API or unknown account evidence', async () => {
  for (const account of [{ type: 'apiKey' }, null]) {
    const { adapter } = await executionFixture(account)
    try {
      expect(await adapter.readExecutionEvidence({ sessionId: 'session-1', fence: 7 })).toBeNull()
    } finally {
      await adapter.closeAll()
    }
  }
})

it('does not grant included-account evidence to a different model provider', async () => {
  const { adapter } = await executionFixture(undefined, 'custom-provider')
  try {
    expect(await adapter.readExecutionEvidence({ sessionId: 'session-1', fence: 7 })).toBeNull()
  } finally {
    await adapter.closeAll()
  }
})

it('invalidates captured facts after a settings change, even if the value changes back', async () => {
  const { adapter, codex } = await executionFixture()
  try {
    const captured = await adapter.readExecutionEvidence({ sessionId: 'session-1', fence: 7 })
    codex.connections[0]!.handlers.onNotification?.('thread/settings/updated', {
      threadId: THREAD_ID,
      threadSettings: { model: 'gpt-other', effort: 'high' }
    })
    codex.connections[0]!.handlers.onNotification?.('thread/settings/updated', {
      threadId: THREAD_ID,
      threadSettings: { model: 'gpt-live', effort: 'low' }
    })
    expect(captured?.isCurrent()).toBe(false)
  } finally {
    await adapter.closeAll()
  }
})

it('invalidates a read if auth changes while the native reply is in flight', async () => {
  const { adapter, codex } = await executionFixture()
  const reply = Promise.withResolvers<unknown>()
  const reading = Promise.withResolvers<void>()
  codex.routes['account/read'] = () => {
    reading.resolve()
    return reply.promise
  }
  try {
    const evidence = adapter.readExecutionEvidence({ sessionId: 'session-1', fence: 7 })
    await reading.promise
    codex.connections[0]!.handlers.onNotification?.('account/updated', { authMode: 'chatgpt' })
    reply.resolve({ account: { type: 'chatgpt', id: 'account-1', planType: 'pro' } })
    expect(await evidence).toBeNull()
  } finally {
    await adapter.closeAll()
  }
})
