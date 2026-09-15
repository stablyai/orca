import { describe, expect, it } from 'vitest'
import {
  MAX_PROVIDER_ACTIVITY_LENGTH,
  claudeProviderFrameActivity,
  codexProviderFrameActivity,
  providerActivityText
} from './provider-frame-activity'

describe('provider frame activity', () => {
  it('derives bounded Codex activity without exposing item payloads or opcodes', () => {
    expect(
      codexProviderFrameActivity('item/started', {
        item: { type: 'commandExecution', command: 'printenv SECRET_TOKEN' }
      })
    ).toBe('Running a command')
    expect(
      codexProviderFrameActivity('item/mcpToolCall/progress', {
        message: '**Indexing repository symbols**'
      })
    ).toBe('Indexing repository symbols')
    expect(
      codexProviderFrameActivity(
        'item/reasoning/summaryTextDelta',
        { delta: 'ignored-fragment' },
        'Inspecting the session wire'
      )
    ).toBe('Inspecting the session wire')
    expect(codexProviderFrameActivity('item/reasoning/summaryPartAdded', {})).toBeNull()
  })

  it('names a fan-out from either Codex item type that reports one', () => {
    for (const type of ['collabAgentToolCall', 'subAgentActivity']) {
      expect(
        codexProviderFrameActivity('item/started', {
          item: { type, kind: 'started', agentThreadId: 'child-1', agentPath: '/root/read' }
        })
      ).toBe('Coordinating with another agent')
    }
  })

  it('leaves the Claude line on the generic fallback, since Claude never narrates its turn', () => {
    // Prose on these frames belongs to a spawned task, not to this turn.
    for (const [kind, payload] of [
      ['message:system:task_started', { description: 'Trace the activity channel' }],
      ['message:system:task_progress', { summary: 'Checking remote compatibility' }],
      ['message:system:task_updated', { patch: { description: 'Validating the renderer' } }],
      ['message:system:control_request_progress', { status: 'api_retry' }],
      ['message:tool_progress', { tool_name: 'ReadSecretFile' }]
    ] as const) {
      expect(claudeProviderFrameActivity(kind, payload)).toBeNull()
    }
    // `requesting` holds for nearly the whole turn and says no more than the fallback.
    expect(
      claudeProviderFrameActivity('message:system:status', { status: 'requesting' })
    ).toBeNull()
    expect(claudeProviderFrameActivity('message:system:status', { status: 'compacting' })).toBe(
      'Compacting the conversation'
    )
    // An unmodeled frame still declines to answer, so it cannot clear live copy.
    expect(claudeProviderFrameActivity('message:system:unknown_frame', {})).toBeUndefined()
  })

  it('falls through on protocol noise and bounds long copy', () => {
    expect(providerActivityText('codex · notification:warning')).toBeNull()
    expect(providerActivityText('item/reasoning/summaryPartAdded')).toBeNull()
    expect(providerActivityText('{"file":"contents"}')).toBeNull()
    const bounded = providerActivityText(`Reviewing ${'long '.repeat(100)}`)
    expect(Array.from(bounded ?? '').length).toBeLessThanOrEqual(MAX_PROVIDER_ACTIVITY_LENGTH)
    expect(bounded?.endsWith('…')).toBe(true)
  })

  it('keeps only the reasoning headline and waits for an unterminated bold header', () => {
    expect(
      codexProviderFrameActivity(
        'item/reasoning/summaryTextDelta',
        {},
        '**Inspecting the workspace**\n\nI am looking at notes.txt before answering.'
      )
    ).toBe('Inspecting the workspace')
    expect(
      codexProviderFrameActivity('item/reasoning/summaryTextDelta', {}, '**Inspecting the wor')
    ).toBeUndefined()
  })
})
