import { describe, expect, it, vi } from 'vitest'
import {
  AGENT_THROUGHPUT_MEASURED_AGENTS,
  type AgentMessageThroughput
} from '../../shared/agent-throughput-types'
import {
  AGENT_THROUGHPUT_SOURCE_PROFILES,
  AgentThroughputTracker,
  type AgentThroughputSourceProfile
} from './agent-throughput-tracker'

const PANE = 'tab-1:0f7c1b2e-3d4a-4c5b-8e6f-7a8b9c0d1e2f'

function hookBody(payload: Record<string, unknown>): unknown {
  return { paneKey: PANE, payload: JSON.stringify(payload) }
}

function message(overrides: Partial<AgentMessageThroughput> = {}): AgentMessageThroughput {
  return {
    messageId: 'msg_1',
    model: 'claude-fable-5-1',
    outputTokens: 500,
    generationMs: 10_000,
    completedAt: 1_000,
    ...overrides
  }
}

function createTracker(
  read: AgentThroughputSourceProfile['read'],
  options: { now?: () => number; streamingReadIntervalMs?: number } = {}
): AgentThroughputTracker {
  const claudeProfile = AGENT_THROUGHPUT_SOURCE_PROFILES.claude!
  const opencodeProfile = AGENT_THROUGHPUT_SOURCE_PROFILES.opencode!
  return new AgentThroughputTracker({
    now: options.now ?? (() => 42),
    profiles: {
      claude: { classify: claudeProfile.classify, read },
      codex: { classify: claudeProfile.classify, read },
      opencode: {
        classify: opencodeProfile.classify,
        read,
        streamingReadIntervalMs: options.streamingReadIntervalMs ?? 1_500
      }
    }
  })
}

async function observe(
  tracker: AgentThroughputTracker,
  hookEventName: string,
  source: 'claude' | 'codex' | 'opencode' | 'grok' = 'claude',
  extra: Record<string, unknown> = {}
): Promise<void> {
  await tracker.observeHook({
    source,
    paneKey: PANE,
    hookEventName,
    body: hookBody({ hook_event_name: hookEventName, transcript_path: 'C:/t/s.jsonl', ...extra })
  })
}

describe('AgentThroughputTracker', () => {
  it('emits one sample per new message and dedupes repeated reads of the same message', async () => {
    const read = vi.fn().mockReturnValue(message())
    const tracker = createTracker(read)
    const listener = vi.fn()
    tracker.setListener(listener)

    await observe(tracker, 'PreToolUse')
    await observe(tracker, 'PostToolUse')

    expect(read).toHaveBeenCalledTimes(2)
    expect(read.mock.calls[0][0]).toMatchObject({ transcript_path: 'C:/t/s.jsonl' })
    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener.mock.calls[0][0]).toEqual({
      paneKey: PANE,
      agentType: 'claude',
      messageId: 'msg_1',
      model: 'claude-fable-5-1',
      outputTokens: 500,
      generationMs: 10_000,
      tokensPerSecond: 50,
      completedAt: 1_000,
      turnOutputTokens: 500,
      turnGenerationMs: 10_000,
      turnMessageCount: 1,
      observedAt: 42
    })
    expect(tracker.getSnapshot()).toHaveLength(1)
  })

  it('accumulates the turn across messages and resets it on the next prompt', async () => {
    const read = vi
      .fn()
      .mockReturnValueOnce(message())
      .mockReturnValueOnce(message({ messageId: 'msg_2', outputTokens: 200, generationMs: 5_000 }))
    const tracker = createTracker(read, { now: () => 7 })
    const listener = vi.fn()
    tracker.setListener(listener)

    await observe(tracker, 'PreToolUse')
    await observe(tracker, 'Stop')
    expect(listener.mock.calls[1][0]).toMatchObject({
      messageId: 'msg_2',
      tokensPerSecond: 40,
      turnOutputTokens: 700,
      turnGenerationMs: 15_000,
      turnMessageCount: 2
    })

    await observe(tracker, 'UserPromptSubmit')
    expect(read).toHaveBeenCalledTimes(2)
    expect(listener).toHaveBeenCalledTimes(3)
    // Why: the last reading stays visible across the turn boundary; only the totals restart.
    expect(listener.mock.calls[2][0]).toMatchObject({
      messageId: 'msg_2',
      tokensPerSecond: 40,
      turnOutputTokens: 0,
      turnGenerationMs: 0,
      turnMessageCount: 0
    })
  })

  it('skips reads without a listener, for ignored events, and for sources without a profile', async () => {
    const read = vi.fn().mockReturnValue(message())
    const tracker = createTracker(read)

    await observe(tracker, 'Stop')
    tracker.setListener(vi.fn())
    await observe(tracker, 'SubagentStart')
    await observe(tracker, 'Notification')
    await observe(tracker, 'Stop', 'grok')
    await tracker.observeHook({
      source: 'claude',
      paneKey: PANE,
      hookEventName: undefined,
      body: {}
    })

    expect(read).not.toHaveBeenCalled()
    expect(tracker.getSnapshot()).toEqual([])
  })

  it('falls back to the hook payload model and labels the agent type', async () => {
    const tracker = createTracker(() => message({ messageId: 'codex:1:2:3', model: null }))
    const listener = vi.fn()
    tracker.setListener(listener)

    await observe(tracker, 'Stop', 'codex', { model: 'gpt-5.5' })

    expect(listener.mock.calls[0][0]).toMatchObject({ agentType: 'codex', model: 'gpt-5.5' })
  })

  it('throttles streaming reads and awaits async readers', async () => {
    let clock = 1_000
    const read = vi.fn().mockImplementation(() => Promise.resolve(message({ messageId: 'oc-1' })))
    const tracker = createTracker(read, { now: () => clock })
    const listener = vi.fn()
    tracker.setListener(listener)
    const part = (role: string) =>
      observe(tracker, 'MessagePart', 'opencode', { role, sessionID: 's1' })

    await part('assistant')
    clock += 200
    await part('assistant')
    clock += 2_000
    await part('assistant')
    await observe(tracker, 'SessionIdle', 'opencode', { sessionID: 's1' })

    // Why: the second part lands inside the streaming floor; SessionIdle always reads.
    expect(read).toHaveBeenCalledTimes(3)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener.mock.calls[0][0]).toMatchObject({ agentType: 'opencode', messageId: 'oc-1' })

    await part('user')
    expect(listener).toHaveBeenCalledTimes(2)
    expect(listener.mock.calls[1][0]).toMatchObject({ turnMessageCount: 0 })
  })

  it('drops a read that resolves after the pane was cleared or superseded', async () => {
    let resolveSlow: (value: AgentMessageThroughput | undefined) => void = () => {}
    const read = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<AgentMessageThroughput | undefined>((resolve) => {
            resolveSlow = resolve
          })
      )
      .mockImplementationOnce(() => message({ messageId: 'fast' }))
    const tracker = createTracker(read)
    const listener = vi.fn()
    tracker.setListener(listener)

    const slow = observe(tracker, 'PreToolUse')
    await observe(tracker, 'Stop')
    resolveSlow(message({ messageId: 'slow' }))
    await slow

    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener.mock.calls[0][0]).toMatchObject({ messageId: 'fast' })

    const cleared = observe(tracker, 'PreToolUse')
    tracker.clear(PANE)
    await cleared
    expect(tracker.getSnapshot()).toEqual([])
  })

  it('clears a pane on SessionStart and on explicit clear, and survives failing readers', async () => {
    const tracker = createTracker(() => message())
    const clearListener = vi.fn()
    tracker.setListener(vi.fn())
    tracker.setClearListener(clearListener)

    await observe(tracker, 'Stop')
    await observe(tracker, 'SessionStart')
    expect(clearListener).toHaveBeenCalledWith(PANE)
    expect(tracker.getSnapshot()).toEqual([])

    tracker.clear(PANE)
    expect(clearListener).toHaveBeenCalledTimes(1)

    await observe(tracker, 'Stop')
    tracker.clearAll()
    expect(clearListener).toHaveBeenCalledTimes(2)

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const throwing = createTracker(() => {
        throw new Error('boom')
      })
      throwing.setListener(() => {
        throw new Error('listener boom')
      })
      await expect(observe(throwing, 'Stop')).resolves.toBe(undefined)
      const listenerThrows = createTracker(() => message())
      listenerThrows.setListener(() => {
        throw new Error('listener boom')
      })
      await observe(listenerThrows, 'Stop')
      expect(listenerThrows.getSnapshot()).toHaveLength(1)
    } finally {
      consoleError.mockRestore()
    }
  })

  it('classifies gemini hooks', () => {
    const gemini = AGENT_THROUGHPUT_SOURCE_PROFILES.gemini!
    expect(gemini.classify('BeforeAgent', {})).toBe('new-turn')
    expect(gemini.classify('AfterTool', {})).toBe('measure')
    expect(gemini.classify('AfterAgent', {})).toBe('measure')
    expect(gemini.classify('SessionStart', {})).toBe('reset')
    expect(gemini.classify('SessionEnd', {})).toBe('reset')
    expect(gemini.classify('Notification', {})).toBe('ignore')
  })

  it('clears the pane when the agent session ends', async () => {
    const tracker = createTracker(() => message())
    const clearListener = vi.fn()
    tracker.setListener(vi.fn())
    tracker.setClearListener(clearListener)

    await observe(tracker, 'Stop')
    expect(tracker.getSnapshot()).toHaveLength(1)
    // Why: the last reading must not outlive the agent that produced it.
    await observe(tracker, 'SessionEnd')
    expect(clearListener).toHaveBeenCalledWith(PANE)
    expect(tracker.getSnapshot()).toEqual([])

    expect(AGENT_THROUGHPUT_SOURCE_PROFILES.grok!.classify('SessionEnd', {})).toBe('reset')
    expect(AGENT_THROUGHPUT_SOURCE_PROFILES.codex!.classify('SessionEnd', {})).toBe('reset')
  })

  it('drops a read that resolves after the next prompt started a new turn', async () => {
    let resolveSlow: (value: AgentMessageThroughput | undefined) => void = () => {}
    const read = vi
      .fn()
      .mockImplementationOnce(() => message({ messageId: 'first' }))
      .mockImplementationOnce(
        () =>
          new Promise<AgentMessageThroughput | undefined>((resolve) => {
            resolveSlow = resolve
          })
      )
      .mockImplementationOnce(() => message({ messageId: 'next-turn', outputTokens: 100 }))
    const tracker = createTracker(read)
    const listener = vi.fn()
    tracker.setListener(listener)

    await observe(tracker, 'Stop')
    const slow = observe(tracker, 'PostToolUse')
    await observe(tracker, 'UserPromptSubmit')
    resolveSlow(message({ messageId: 'stale', outputTokens: 900 }))
    await slow
    await observe(tracker, 'Stop')

    // Why: the stale read would otherwise count 900 tokens into the new turn's totals.
    const last = listener.mock.calls.at(-1)![0]
    expect(last).toMatchObject({
      messageId: 'next-turn',
      turnOutputTokens: 100,
      turnMessageCount: 1
    })
    expect(listener.mock.calls.some(([sample]) => sample.messageId === 'stale')).toBe(false)
  })

  it('advertises exactly the sources it can read', () => {
    // Why: the renderer's "not available for this agent" hint is driven by the shared list.
    expect(Object.keys(AGENT_THROUGHPUT_SOURCE_PROFILES).sort()).toEqual(
      [...AGENT_THROUGHPUT_MEASURED_AGENTS].sort()
    )
  })
})
