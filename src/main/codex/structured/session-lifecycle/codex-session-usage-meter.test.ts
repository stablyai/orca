import { expect, it } from 'vitest'
import {
  acquireReadyCodexForTest,
  adapterFor,
  fakeCodex,
  identityFor,
  THREAD_ID
} from './codex-structured-session-adapter-fixture'

async function fixture(resumed = false) {
  const settings = { model: 'gpt-live', effort: 'low', modelProvider: 'openai' }
  const codex = fakeCodex({
    'account/read': () => ({
      account: { type: 'chatgpt', id: 'account-1', email: 'private@invalid.test', planType: 'pro' }
    }),
    'thread/start': () => ({
      thread: { id: THREAD_ID, modelProvider: 'openai', status: { type: 'idle' } },
      model: 'gpt-live',
      reasoningEffort: 'low',
      modelProvider: 'openai'
    }),
    'thread/resume': () => ({
      thread: { id: THREAD_ID, modelProvider: 'openai', status: { type: 'idle' } },
      model: 'gpt-live',
      reasoningEffort: 'low',
      modelProvider: 'openai'
    })
  })
  const adapter = adapterFor(codex, { resumeThreadId: resumed ? THREAD_ID : null })
  await acquireReadyCodexForTest(adapter, {
    identity: identityFor('session-1'),
    fence: 7,
    spawnToken: 'spawn-9'
  })
  const read = () => adapter.readUsageMeter({ sessionId: 'session-1', fence: 7 })
  const notify = (method: string, params: unknown) =>
    codex.connections[0]!.handlers.onNotification?.(method, params)
  const usage = (total = 99, threadId = THREAD_ID) =>
    notify('thread/tokenUsage/updated', {
      threadId,
      tokenUsage: {
        total: {
          totalTokens: total,
          inputTokens: total - 19,
          cachedInputTokens: 32,
          outputTokens: 19,
          reasoningOutputTokens: 12
        }
      }
    })
  return { adapter, codex, read, notify, usage, settings }
}

it('reads an actual held account and cumulative tokens without requiring worker execution permissions', async () => {
  const f = await fixture()
  try {
    const before = await f.read()
    expect(before?.meter).toMatchObject({
      version: 1,
      agent: 'codex',
      sessionId: 'session-1',
      runtimeFence: 7,
      acquisitionGeneration: 'generation-1',
      model: 'gpt-live',
      effort: 'low',
      scope: 'primary-thread',
      quiescent: true,
      origin: 'fresh-thread',
      account: {
        fingerprint: 'codex:07e998012c1137decdf3efbbb1c3ee6d79b015638cbc197bdbcce1875de4faad',
        plan: 'pro'
      },
      usage: { threadId: THREAD_ID, totalTokens: 0, inputTokens: 0, outputTokens: 0 }
    })
    f.usage(900, 'foreign-thread')
    f.usage()
    const after = await f.read()
    expect(after?.meter).toMatchObject({
      origin: 'provider-counter',
      usage: {
        totalTokens: 99,
        inputTokens: 80,
        cachedInputTokens: 32,
        outputTokens: 19,
        reasoningOutputTokens: 12
      }
    })
    expect(after?.meter.meterId).toBe(before?.meter.meterId)
    expect(before?.isCurrent()).toBe(false)
    expect(JSON.stringify(after?.meter)).not.toMatch(/private@|account-1/)
    expect(await f.adapter.readUsageMeter({ sessionId: 'session-1', fence: 8 })).toBeNull()
  } finally {
    await f.adapter.closeAll()
  }
})

it('never assumes a zero baseline for a resumed thread and keeps counter corruption unknown', async () => {
  const f = await fixture(true)
  try {
    expect(await f.read()).toBeNull()
    f.usage()
    expect((await f.read())?.meter.usage.totalTokens).toBe(99)
    f.usage(98)
    expect(await f.read()).toBeNull()
    f.usage(120)
    expect(await f.read()).toBeNull()
  } finally {
    await f.adapter.closeAll()
  }
})

it('requires a new provider counter after every turn before measuring another interval', async () => {
  const f = await fixture()
  try {
    f.usage()
    expect((await f.read())?.meter.usage.totalTokens).toBe(99)
    f.notify('turn/started', { threadId: THREAD_ID, turn: { id: 'missing-counter' } })
    f.notify('turn/completed', {
      threadId: THREAD_ID,
      turn: { id: 'missing-counter', status: 'completed' }
    })
    expect(await f.read()).toBeNull()
    f.usage(120)
    expect((await f.read())?.meter.usage.totalTokens).toBe(120)
    f.notify('thread/status/changed', { threadId: THREAD_ID, status: { type: 'active' } })
    f.notify('thread/status/changed', { threadId: THREAD_ID, status: { type: 'idle' } })
    expect(await f.read()).toBeNull()
  } finally {
    await f.adapter.closeAll()
  }
})

it('changes the meter identity after model or account changes even when the original values return', async () => {
  const f = await fixture()
  try {
    f.usage()
    const before = await f.read()
    f.notify('thread/settings/updated', {
      threadId: THREAD_ID,
      threadSettings: { ...f.settings, model: 'other' }
    })
    f.notify('thread/settings/updated', { threadId: THREAD_ID, threadSettings: f.settings })
    expect(await f.read()).toBeNull()
    f.usage(120)
    const changed = await f.read()
    expect(changed?.meter.meterId).not.toBe(before?.meter.meterId)
    f.notify('account/updated', {})
    f.usage(140)
    expect((await f.read())?.meter.meterId).not.toBe(changed?.meter.meterId)
  } finally {
    await f.adapter.closeAll()
  }
})

it('discards an account-read race and never treats an active turn as a zero-cost interval', async () => {
  const f = await fixture()
  const account = Promise.withResolvers<unknown>()
  try {
    f.codex.routes['account/read'] = () => account.promise
    const reading = f.read()
    f.notify('account/updated', {})
    account.resolve({ account: { type: 'chatgpt', id: 'account-1', planType: 'pro' } })
    expect(await reading).toBeNull()
    expect((await f.read())?.meter.usage.totalTokens).toBe(0)
    f.notify('turn/started', { threadId: THREAD_ID, turn: { id: 'turn-1' } })
    expect(await f.read()).toBeNull()
    f.usage()
    expect(await f.read()).toBeNull()
    f.notify('turn/completed', { threadId: THREAD_ID, turn: { id: 'turn-1', status: 'completed' } })
    expect((await f.read())?.meter.usage.totalTokens).toBe(99)
    f.codex.routes['account/read'] = () => ({ account: { type: 'apiKey' } })
    expect(await f.read()).toBeNull()
  } finally {
    account.resolve({})
    await f.adapter.closeAll()
  }
})
