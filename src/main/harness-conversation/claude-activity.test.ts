import { describe, expect, it, vi } from 'vitest'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { HarnessConversationDriverSink } from './driver'
import { ClaudeConversationActivity } from './claude-activity'

function createSink(): HarnessConversationDriverSink {
  return {
    emit: vi.fn(),
    setProviderSessionId: vi.fn(),
    setConfiguration: vi.fn(),
    setContext: vi.fn(),
    setSubagents: vi.fn(),
    setTranscriptPath: vi.fn()
  }
}

describe('ClaudeConversationActivity', () => {
  it('does not render hook lifecycle telemetry as tool activity', () => {
    const sink = createSink()
    const activity = new ClaudeConversationActivity(sink)

    activity.observe({
      type: 'system',
      subtype: 'hook_started',
      hook_id: 'startup-hook',
      hook_name: 'UserPromptSubmit',
      hook_event: 'UserPromptSubmit',
      uuid: '00000000-0000-4000-8000-000000000000',
      session_id: 'session-1'
    })

    expect(sink.emit).not.toHaveBeenCalled()
  })

  it('publishes provider context and real subagent tasks', () => {
    const sink = createSink()
    const activity = new ClaudeConversationActivity(sink)

    activity.observe({
      type: 'system',
      subtype: 'init',
      model: 'claude-opus',
      fast_mode_state: 'on'
    } as unknown as SDKMessage)
    activity.observe({
      type: 'assistant',
      effort: 'high',
      message: {
        model: 'claude-opus',
        usage: {
          input_tokens: 2,
          cache_creation_input_tokens: 20,
          cache_read_input_tokens: 100
        }
      }
    } as unknown as SDKMessage)
    activity.observe({
      type: 'result',
      modelUsage: { 'claude-opus': { contextWindow: 1_000_000 } }
    } as unknown as SDKMessage)
    activity.observe({
      type: 'system',
      subtype: 'task_started',
      task_id: 'child',
      task_type: 'local_agent',
      description: 'Inspect the renderer'
    } as SDKMessage)

    expect(sink.setContext).toHaveBeenLastCalledWith(
      expect.objectContaining({
        model: 'claude-opus',
        effort: 'high',
        fastMode: true,
        usedTokens: 122,
        maxTokens: 1_000_000,
        remainingTokens: 999_878
      })
    )
    expect(sink.setSubagents).toHaveBeenLastCalledWith([
      expect.objectContaining({ id: 'child', state: 'working' })
    ])
  })
})
