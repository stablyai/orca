import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import { agentSessionRecordFixture } from '../../shared/agent-session-record.test-fixture'
import { StructuredAgentSessionStatusFeed } from './agent-session-wire/structured-agent-session-status-feed'
import type {
  AgentSessionStatusEvent,
  AgentSessionStatusSummary
} from '../../shared/agent-session-wire'
import { STRUCTURED_CHAT_NAME_PROMPT_LIMIT } from '../../shared/structured-agent-session-first-prompt'
import {
  type AgentSessionUserNameWrite,
  compareAndSetAgentSessionRecordName,
  setAgentSessionRecordUserName
} from '../runtime/agent-session-record-conversation-name'
import {
  createStructuredChatNamingHandler,
  type StructuredChatNameGeneration,
  type StructuredChatNamingDeps
} from './structured-chat-naming'
import { firstStructuredChatNamingPrompt } from '../../shared/structured-chat-naming-eligibility'
import {
  attach,
  CALLER,
  envelope,
  hostTestState
} from './agent-session-wire/structured-agent-session-host-test-harness'
import {
  HOST_TEST_SESSION,
  hostTestMessage
} from './agent-session-wire/structured-agent-session-host-test-data'

function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error('Deferred not initialized')
  }
  const promise = new Promise<T>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}

async function settle() {
  for (let index = 0; index < 12; index += 1) {
    await Promise.resolve()
  }
}

function rig(provider: 'claude' | 'codex') {
  let record: AgentSessionRecord | null = { ...agentSessionRecordFixture(), provider }
  const getRecord = vi.fn(() => record)
  // The store's own rules, over this rig's one record.
  const mutate = async (apply: (current: AgentSessionRecord) => AgentSessionRecord) => {
    if (!record) {
      throw new Error('Missing record')
    }
    record = apply(record)
    return record
  }
  const setConversationName = vi.fn((_id: string, name: string | null, expected: string | null) =>
    compareAndSetAgentSessionRecordName(mutate, name, expected)
  )
  const setUserConversationName = vi.fn(
    async (_id: string, name: string, write: AgentSessionUserNameWrite) => {
      let applied = false
      const next = await mutate((current) => {
        const result = setAgentSessionRecordUserName(current, name, write, Date.now())
        applied = result.applied
        return result.record
      })
      return { record: next, applied }
    }
  )
  const deps: StructuredChatNamingDeps = {
    getStore: () => ({
      getRecord,
      compareAndSetConversationName: setConversationName,
      setUserConversationName
    }),
    getSettings: () => ({}),
    now: () => 100,
    workerTaskTitle: vi.fn(() => null),
    readFirstPrompt: vi.fn(async () => 'Please repair the login flow'),
    readJournalFirstPrompt: vi.fn(async () => 'Please repair the login flow'),
    generate: vi.fn(async (): Promise<StructuredChatNameGeneration> => ({ name: 'auth/login' })),
    onNamed: vi.fn(),
    logger: { warn: vi.fn(), error: vi.fn() },
    wait: vi.fn(async () => {})
  }
  const summary: AgentSessionStatusSummary = {
    sessionId: record.sessionId,
    workspaceId: record.location.workspaceId,
    agent: provider,
    status: 'working',
    latestPrompt: 'login preview',
    updatedAt: 100
  }
  return {
    deps,
    summary,
    getRecord,
    setConversationName,
    setUserConversationName,
    handle: createStructuredChatNamingHandler(deps),
    read: () => record,
    replace: (next: AgentSessionRecord | null) => {
      record = next
    }
  }
}

describe.each(['claude', 'codex'] as const)('structured %s chat naming', (provider) => {
  it('still names the first message after a manual rename fails to save', async () => {
    const state = rig(provider)
    state.setUserConversationName.mockRejectedValueOnce(new Error('Save failed'))
    await expect(
      state.handle.setUserName(state.summary.sessionId, 'Manual name', 'rename')
    ).rejects.toThrow('Save failed')
    expect(state.read()?.conversationName).toBeUndefined()
    state.handle(state.summary, { replay: false, firstInputSubmissionKey: 'first-message' })
    await settle()
    expect(state.setConversationName).toHaveBeenCalledWith(
      state.summary.sessionId,
      'Please repair the login flow',
      null
    )
    expect(state.deps.generate).toHaveBeenCalledTimes(1)
    expect(state.read()?.conversationName).toBe('auth/login')
  })

  it('names the chat from its first prompt at once, then takes the generated name', async () => {
    const state = rig(provider)
    const generation = deferred<StructuredChatNameGeneration>()
    state.deps.generate = vi.fn(() => generation.promise)
    expect(state.handle(state.summary, { replay: false })).toBeUndefined()
    await settle()
    expect(state.read()?.conversationName).toBe('Please repair the login flow')
    expect(state.deps.onNamed).toHaveBeenCalledTimes(2)
    expect(state.deps.readFirstPrompt).toHaveBeenCalledWith(state.summary.sessionId, 100)
    generation.resolve({ name: 'auth/login' })
    await settle()
    expect(state.read()?.conversationName).toBe('auth/login')
    expect(state.deps.onNamed).toHaveBeenCalledTimes(4)
  })

  it('clips a long first prompt into a short name', async () => {
    const state = rig(provider)
    const generation = deferred<StructuredChatNameGeneration>()
    state.deps.generate = vi.fn(() => generation.promise)
    state.deps.readFirstPrompt = async () =>
      'use /agent-slack to search the thread and bring indexed search to cmd + j'
    state.handle(state.summary, { replay: false })
    await settle()
    expect(state.read()?.conversationName).toBe('use /agent-slack to search the thread and bring…')
  })

  it.each([null, 'idle', 'attention'] as const)('does no work for status %s', async (status) => {
    const state = rig(provider)
    state.handle({ ...state.summary, status }, { replay: false })
    await settle()
    expect(state.getRecord).not.toHaveBeenCalled()
    expect(state.deps.generate).not.toHaveBeenCalled()
  })

  it('does no work on replay', async () => {
    const state = rig(provider)
    state.handle(state.summary, { replay: true })
    await settle()
    expect(state.getRecord).not.toHaveBeenCalled()
    expect(state.deps.generate).not.toHaveBeenCalled()
  })

  it.each(['missing', 'named'] as const)('skips a %s record', async (kind) => {
    const state = rig(provider)
    const record = state.read()
    if (!record) {
      throw new Error('Missing fixture')
    }
    state.replace(kind === 'missing' ? null : { ...record, conversationName: 'Existing name' })
    state.handle(state.summary, { replay: false })
    await settle()
    expect(state.deps.readFirstPrompt).not.toHaveBeenCalled()
    expect(state.deps.generate).not.toHaveBeenCalled()
  })

  it('names an orchestration worker after its task without generating', async () => {
    const state = rig(provider)
    state.deps.workerTaskTitle = () => ({ title: 'PR27814 final readiness review' })
    state.handle(state.summary, { replay: false })
    await settle()
    expect(state.read()?.conversationName).toBe('PR27814 final readiness review')
    expect(state.deps.onNamed).toHaveBeenCalledTimes(3)
    expect(state.deps.readFirstPrompt).not.toHaveBeenCalled()
    expect(state.deps.generate).not.toHaveBeenCalled()
  })

  it('leaves a worker unnamed when naming is off', async () => {
    const state = rig(provider)
    state.deps.workerTaskTitle = () => ({ title: 'PR27814 final readiness review' })
    state.deps.getSettings = () => ({ nativeChatAutoName: false })
    state.handle(state.summary, { replay: false })
    await settle()
    expect(state.read()?.conversationName).toBeUndefined()
  })

  it('does not generate from a worker preamble when its task has no usable title', async () => {
    const state = rig(provider)
    state.deps.workerTaskTitle = () => ({ title: '' })
    state.handle(state.summary, { replay: false })
    await settle()
    expect(state.read()?.conversationName).toBeUndefined()
    expect(state.deps.readFirstPrompt).not.toHaveBeenCalled()
    expect(state.deps.generate).not.toHaveBeenCalled()
  })

  it('stays unnamed when disabled, including after enabling', async () => {
    const state = rig(provider)
    state.deps.getSettings = () => ({ nativeChatAutoName: false })
    state.handle(state.summary, { replay: false })
    await settle()
    state.deps.getSettings = () => ({ nativeChatAutoName: true })
    state.handle(state.summary, { replay: false })
    await settle()
    expect(state.setConversationName).not.toHaveBeenCalled()
    expect(state.read()?.conversationName).toBeUndefined()
    expect(state.deps.generate).not.toHaveBeenCalled()
  })

  it.each(['rejected', 'failed', 'empty'] as const)(
    'retries %s generation twice, then keeps the first-prompt name and the failure',
    async (outcome) => {
      const state = rig(provider)
      state.deps.generate = vi.fn(async () => {
        if (outcome === 'rejected') {
          throw new Error('Agent failed')
        }
        return outcome === 'empty' ? { name: '' } : { error: 'Invalid API key' }
      })
      state.handle(state.summary, { replay: false })
      await settle()
      state.handle({ ...state.summary, status: 'idle' }, { replay: false })
      state.handle({ ...state.summary, latestPrompt: 'Second request' }, { replay: false })
      await settle()
      expect(state.read()?.conversationName).toBe('Please repair the login flow')
      expect(state.deps.generate).toHaveBeenCalledTimes(3)
      expect(state.deps.wait).toHaveBeenNthCalledWith(1, 2000)
      expect(state.deps.wait).toHaveBeenNthCalledWith(2, 4000)
      expect(state.setConversationName).toHaveBeenCalledTimes(1)
      expect(state.handle.failure(state.summary.sessionId)).toMatchObject({
        forName: 'Please repair the login flow',
        ...(outcome === 'failed' ? { message: 'Invalid API key' } : {})
      })
      expect(state.deps.onNamed).toHaveBeenCalledTimes(4)
    }
  )

  it('keeps the first-prompt name without retries or a failure where naming cannot run', async () => {
    const state = rig(provider)
    state.deps.generate = vi.fn(async () => null)
    state.handle(state.summary, { replay: false })
    await settle()
    expect(state.read()?.conversationName).toBe('Please repair the login flow')
    expect(state.deps.generate).toHaveBeenCalledTimes(1)
    expect(state.deps.wait).not.toHaveBeenCalled()
    expect(state.handle.failure(state.summary.sessionId)).toBeUndefined()
  })

  it('regenerates a failed name with one try each, replacing the current name', async () => {
    const state = rig(provider)
    state.deps.generate = vi.fn(async () => ({ error: 'Invalid API key' }))
    state.handle(state.summary, { replay: false })
    await settle()
    const first = state.handle.failure(state.summary.sessionId)
    state.deps.generate = vi.fn(async () => ({ error: 'Still invalid' }))
    expect(state.handle.regenerate(state.summary.sessionId)).toBe(true)
    await settle()
    expect(state.deps.generate).toHaveBeenCalledTimes(1)
    expect(state.deps.wait).toHaveBeenCalledTimes(2)
    expect(state.handle.failure(state.summary.sessionId)).toMatchObject({
      message: 'Still invalid'
    })
    expect(state.handle.failure(state.summary.sessionId)).not.toBe(first)
    state.deps.generate = vi.fn(async () => ({ name: 'auth/login' }))
    state.handle.regenerate(state.summary.sessionId)
    await settle()
    expect(state.read()?.conversationName).toBe('auth/login')
    expect(state.setConversationName).toHaveBeenLastCalledWith(
      state.summary.sessionId,
      'auth/login',
      'Please repair the login flow'
    )
    expect(state.handle.failure(state.summary.sessionId)).toBeUndefined()
  })

  it.each(['read', 'save'] as const)(
    'publishes completion after a rejected %s without a summary',
    async (stage) => {
      const state = rig(provider)
      const id = state.summary.sessionId
      state.deps.generate = vi.fn(async () => ({ error: 'Agent failed' }))
      state.handle(state.summary, { replay: false })
      await settle()
      const failure = state.handle.failure(id)
      const feed = new StructuredAgentSessionStatusFeed({
        sessions: new Map(),
        getRecord: state.getRecord,
        now: () => 100,
        logger: state.deps.logger,
        namingActiveSessionIds: state.handle.activeSessionIds
      })
      const events: AgentSessionStatusEvent[] = []
      feed.subscribe({ id: 'client', emit: (event) => events.push(event) })
      state.deps.onNamed = (_workspace, session) => feed.publishConversationName(session)
      const prompt = deferred<string>()
      state.deps.readJournalFirstPrompt = vi.fn(() =>
        stage === 'read'
          ? prompt.promise.then(() => {
              throw new Error('read failed')
            })
          : prompt.promise
      )
      state.setConversationName.mockRejectedValueOnce(new Error('save failed'))
      state.deps.generate = vi.fn(async () => ({ name: 'New name' }))
      state.handle.regenerate(id)
      state.handle.regenerate(id)
      expect(events.at(-1)).toMatchObject({
        type: 'snapshot',
        sessions: [],
        namingActiveSessionIds: [id]
      })
      prompt.resolve('Repair login')
      await settle()
      expect(state.deps.readJournalFirstPrompt).toHaveBeenCalledTimes(1)
      expect(events.at(-1)).toMatchObject({
        type: 'snapshot',
        sessions: [],
        namingActiveSessionIds: []
      })
      expect(state.handle.failure(id)).toBe(failure)
      state.deps.readJournalFirstPrompt = async () => ''
      state.handle.regenerate(id)
      expect(state.handle.activeSessionIds()).toEqual([id])
      await settle()
      expect(state.handle.activeSessionIds()).toEqual([])
    }
  )

  it('takes the generated name from a retry after a failed first try', async () => {
    const state = rig(provider)
    state.deps.generate = vi
      .fn<StructuredChatNamingDeps['generate']>()
      .mockRejectedValueOnce(new Error('Agent failed'))
      .mockResolvedValueOnce({ name: 'auth/login' })
    state.handle(state.summary, { replay: false })
    await settle()
    expect(state.read()?.conversationName).toBe('auth/login')
    expect(state.deps.generate).toHaveBeenCalledTimes(2)
  })

  it('protects a name changed while generation runs', async () => {
    const state = rig(provider)
    const generation = deferred<StructuredChatNameGeneration>()
    state.deps.generate = vi.fn(() => generation.promise)
    state.handle(state.summary, { replay: false })
    await settle()
    const current = state.read()
    if (!current) {
      throw new Error('Missing fixture')
    }
    state.replace({ ...current, conversationName: 'User name' })
    generation.resolve({ name: 'Late agent name' })
    await settle()
    expect(state.read()?.conversationName).toBe('User name')
    expect(state.deps.onNamed).toHaveBeenCalledTimes(3)
  })

  it('protects a name changed while the first prompt is read', async () => {
    const state = rig(provider)
    const prompt = deferred<string>()
    state.deps.readFirstPrompt = () => prompt.promise
    state.handle(state.summary, { replay: false })
    const current = state.read()
    if (!current) {
      throw new Error('Missing fixture')
    }
    state.replace({ ...current, conversationName: 'User name' })
    prompt.resolve('Please repair the login flow')
    await settle()
    expect(state.read()?.conversationName).toBe('User name')
    expect(state.deps.generate).not.toHaveBeenCalled()
  })

  it.each([{ name: 'Late agent name' }, { error: 'Generation failed' }])(
    'keeps a same-text user rename after generation settles with %j',
    async (outcome) => {
      const state = rig(provider)
      const generation = deferred<StructuredChatNameGeneration>()
      state.deps.generate = vi.fn(() => generation.promise)
      state.handle(state.summary, { replay: false })
      await settle()
      const id = state.summary.sessionId
      const seed = 'Please repair the login flow'
      await state.handle.setUserName(id, 'Login work', 'rename')
      await state.handle.setUserName(id, seed, 'rename')
      generation.resolve(outcome)
      await settle()
      expect(state.read()).toMatchObject({ conversationName: seed, conversationNameSource: 'user' })
      expect(state.handle.failure(id)).toBeUndefined()
    }
  )

  it("takes a window's pre-upgrade tab name only over a name Orca chose", async () => {
    const state = rig(provider)
    const id = state.summary.sessionId
    await state.handle(state.summary, { replay: false })
    await settle()
    expect(await state.handle.setUserName(id, 'Old tab name', 'legacy-alias')).toEqual({
      name: 'Old tab name',
      applied: true
    })
    await state.handle.setUserName(id, 'Newer rename', 'rename')
    // A second window's, or a replayed, upload of an older name never replaces the newer rename.
    expect(await state.handle.setUserName(id, 'Old tab name', 'legacy-alias')).toEqual({
      name: 'Newer rename',
      applied: false
    })
  })

  it('coalesces concurrent edges before the first journal read completes', async () => {
    const state = rig(provider)
    const prompt = deferred<string>()
    state.deps.readFirstPrompt = vi.fn(() => prompt.promise)
    state.handle(state.summary, { replay: false })
    state.handle(state.summary, { replay: false })
    await settle()
    expect(state.deps.readFirstPrompt).toHaveBeenCalledTimes(1)
    prompt.resolve('Repair the login flow')
    await settle()
    expect(state.deps.generate).toHaveBeenCalledTimes(1)
  })

  it.each(['', '?!'] as const)('keeps an unusable first prompt %j unnamed', async (prompt) => {
    const state = rig(provider)
    state.deps.readFirstPrompt = async () => prompt
    state.handle(state.summary, { replay: false })
    await settle()
    expect(state.setConversationName).not.toHaveBeenCalled()
    expect(state.deps.generate).not.toHaveBeenCalled()
  })

  it('generates from a URL-only first message', async () => {
    const state = rig(provider)
    const prompt = 'https://example.test/issues/123'
    const generation = deferred<StructuredChatNameGeneration>()
    state.deps.readFirstPrompt = async () => prompt
    state.deps.generate = vi.fn(() => generation.promise)
    state.handle(state.summary, { replay: false })
    await settle()
    expect(state.read()?.conversationName).toBe(prompt)
    expect(state.deps.generate).toHaveBeenCalledWith(expect.anything(), prompt)
    generation.resolve({ name: 'auth/login' })
    await settle()
    expect(state.read()?.conversationName).toBe('auth/login')
  })

  it('leaves an unreadable journal unnamed and does not retry', async () => {
    const state = rig(provider)
    state.deps.readFirstPrompt = vi.fn(async () => {
      throw new Error('Unavailable')
    })
    state.handle(state.summary, { replay: false })
    await settle()
    state.handle(state.summary, { replay: false })
    await settle()
    expect(state.deps.readFirstPrompt).toHaveBeenCalledTimes(1)
    expect(state.deps.generate).not.toHaveBeenCalled()
    expect(state.read()?.conversationName).toBeUndefined()
    expect(state.deps.logger.warn).toHaveBeenCalled()
  })

  it('clips the first prompt without splitting a Unicode character', async () => {
    const state = rig(provider)
    const prefix = 'A'.repeat(STRUCTURED_CHAT_NAME_PROMPT_LIMIT - 1)
    state.deps.readFirstPrompt = async () => `${prefix}𠮷`
    state.handle(state.summary, { replay: false })
    await settle()
    expect(state.deps.generate).toHaveBeenCalledWith(expect.anything(), prefix)
  })

  it('keeps the saved name when snapshot refresh fails', async () => {
    const state = rig(provider)
    state.deps.onNamed = () => {
      throw new Error('Publish failed')
    }
    state.handle(state.summary, { replay: false })
    await settle()
    expect(state.read()?.conversationName).toBe('auth/login')
    expect(state.deps.logger.warn).toHaveBeenCalled()
  })

  it('contains synchronous dependency and reporting failures off the send path', async () => {
    const state = rig(provider)
    state.deps.getStore = () => {
      throw new Error('Store failed')
    }
    state.deps.logger.warn = () => {
      throw new Error('Logger failed')
    }
    const print = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(() => state.handle(state.summary, { replay: false })).not.toThrow()
    await settle()
    expect(state.deps.generate).not.toHaveBeenCalled()
    print.mockRestore()
  })
})

it("names a chat from a real host's status feed once its first send runs", async () => {
  const { host, store, log } = hostTestState()
  host.deps.onSessionStatusChanged = createStructuredChatNamingHandler({
    getStore: () => store,
    getSettings: () => ({}),
    workerTaskTitle: () => null,
    readFirstPrompt: async (id, startedAt) =>
      firstStructuredChatNamingPrompt(await host.journalSnapshot(id), startedAt),
    readJournalFirstPrompt: async () => '',
    generate: async () => ({ name: 'auth/login' }),
    onNamed: vi.fn(),
    logger: log.logger
  })
  await attach()

  const body = hostTestMessage('Please repair the login flow')
  expect(
    await host.send(CALLER, { envelope: envelope('agentSession.send', { body }), body })
  ).toMatchObject({ ok: true })

  await vi.waitFor(() =>
    expect(store.getRecord(HOST_TEST_SESSION)?.conversationName).toBe('auth/login')
  )
})
