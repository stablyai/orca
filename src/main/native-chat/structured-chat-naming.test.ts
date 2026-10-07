import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import { agentSessionRecordFixture } from '../../shared/agent-session-record.test-fixture'
import type { AgentSessionStatusSummary } from '../../shared/agent-session-wire'
import { STRUCTURED_CHAT_NAME_PROMPT_LIMIT } from '../../shared/structured-agent-session-first-prompt'
import { setAgentSessionRecordConversationName } from '../runtime/agent-session-record-conversation-name'
import {
  createStructuredChatNamingHandler,
  type StructuredChatNamingDeps
} from './structured-chat-naming'

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
  const setConversationName = vi.fn(
    async (_id: string, name: string | null, expected: string | null) => {
      if (!record) {
        throw new Error('Missing record')
      }
      if ((record.conversationName ?? null) !== expected) {
        return null
      }
      record = setAgentSessionRecordConversationName(record, name, Date.now())
      return record
    }
  )
  const deps: StructuredChatNamingDeps = {
    getStore: () => ({ getRecord, compareAndSetConversationName: setConversationName }),
    getSettings: () => ({}),
    now: () => 100,
    hasOpenDispatch: vi.fn(() => false),
    readFirstPrompt: vi.fn(async () => 'Please repair the login flow'),
    generate: vi.fn(async () => 'auth/login'),
    onNamed: vi.fn(),
    logger: { warn: vi.fn(), error: vi.fn() }
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
    handle: createStructuredChatNamingHandler(deps),
    read: () => record,
    replace: (next: AgentSessionRecord | null) => {
      record = next
    }
  }
}

describe.each(['claude', 'codex'] as const)('structured %s chat naming', (provider) => {
  it('writes only the generated name without awaiting generation', async () => {
    const state = rig(provider)
    const generation = deferred<string | null>()
    state.deps.generate = vi.fn(() => generation.promise)
    expect(state.handle(state.summary, { replay: false })).toBeUndefined()
    await settle()
    expect(state.read()?.conversationName).toBeUndefined()
    expect(state.setConversationName).not.toHaveBeenCalled()
    expect(state.deps.onNamed).not.toHaveBeenCalled()
    expect(state.deps.readFirstPrompt).toHaveBeenCalledWith(state.summary.sessionId, 100)
    generation.resolve('auth/login')
    await settle()
    expect(state.read()?.conversationName).toBe('auth/login')
    expect(state.deps.onNamed).toHaveBeenCalledTimes(1)
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

  it.each(['missing', 'named', 'worker'] as const)('skips a %s record', async (kind) => {
    const state = rig(provider)
    const record = state.read()
    if (!record) {
      throw new Error('Missing fixture')
    }
    if (kind === 'missing') {
      state.replace(null)
    } else if (kind === 'named') {
      state.replace({ ...record, conversationName: 'Existing name' })
    } else {
      state.deps.hasOpenDispatch = () => true
    }
    state.handle(state.summary, { replay: false })
    await settle()
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

  it.each(['rejected', 'declined', 'empty'] as const)(
    'leaves %s generation unnamed without retrying',
    async (outcome) => {
      const state = rig(provider)
      state.deps.generate = vi.fn(async () => {
        if (outcome === 'rejected') {
          throw new Error('Agent failed')
        }
        return outcome === 'empty' ? '' : null
      })
      state.handle(state.summary, { replay: false })
      await settle()
      state.handle({ ...state.summary, status: 'idle' }, { replay: false })
      state.handle({ ...state.summary, latestPrompt: 'Second request' }, { replay: false })
      await settle()
      expect(state.read()?.conversationName).toBeUndefined()
      expect(state.deps.generate).toHaveBeenCalledTimes(1)
      expect(state.setConversationName).not.toHaveBeenCalled()
    }
  )

  it('protects a name changed while generation runs', async () => {
    const state = rig(provider)
    const generation = deferred<string | null>()
    state.deps.generate = vi.fn(() => generation.promise)
    state.handle(state.summary, { replay: false })
    await settle()
    const current = state.read()
    if (!current) {
      throw new Error('Missing fixture')
    }
    state.replace({ ...current, conversationName: 'User name' })
    generation.resolve('Late agent name')
    await settle()
    expect(state.read()?.conversationName).toBe('User name')
    expect(state.deps.onNamed).not.toHaveBeenCalled()
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

  it('coalesces concurrent edges before the first journal read completes', async () => {
    const state = rig(provider)
    const prompt = deferred<string>()
    state.deps.readFirstPrompt = vi.fn(() => prompt.promise)
    state.handle(state.summary, { replay: false })
    state.handle(state.summary, { replay: false })
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
    const generation = deferred<string | null>()
    state.deps.readFirstPrompt = async () => prompt
    state.deps.generate = vi.fn(() => generation.promise)
    state.handle(state.summary, { replay: false })
    await settle()
    expect(state.read()?.conversationName).toBeUndefined()
    expect(state.deps.generate).toHaveBeenCalledWith(expect.anything(), prompt)
    generation.resolve('auth/login')
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
