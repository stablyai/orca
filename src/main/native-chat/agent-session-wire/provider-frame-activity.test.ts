import { describe, expect, it } from 'vitest'
import {
  MAX_PROVIDER_ACTIVITY_LENGTH,
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
