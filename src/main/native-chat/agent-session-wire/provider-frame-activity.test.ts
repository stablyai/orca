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

  it('uses Claude descriptions and safe semantic status without exposing tool labels', () => {
    expect(
      claudeProviderFrameActivity('message:system:task_started', {
        description: 'Trace the activity channel'
      })
    ).toBe('Working on: Trace the activity channel')
    expect(
      claudeProviderFrameActivity('message:system:task_progress', {
        description: 'Reading tests',
        summary: 'Checking remote compatibility'
      })
    ).toBe('Checking remote compatibility')
    expect(
      claudeProviderFrameActivity('message:system:task_updated', {
        patch: { description: 'Validating the renderer' }
      })
    ).toBe('Validating the renderer')
    expect(claudeProviderFrameActivity('message:system:status', { status: 'compacting' })).toBe(
      'Compacting the conversation'
    )
    expect(
      claudeProviderFrameActivity('message:system:control_request_progress', {
        status: 'api_retry'
      })
    ).toBe('Retrying a side question')
    expect(
      claudeProviderFrameActivity('message:tool_progress', {
        tool_name: 'ReadSecretFile'
      })
    ).toBeNull()
  })

  it('falls through on protocol noise and redacts credential-shaped text', () => {
    expect(providerActivityText('codex · notification:warning')).toBeNull()
    expect(providerActivityText('item/reasoning/summaryPartAdded')).toBeNull()
    expect(providerActivityText('{"file":"contents"}')).toBeNull()
    expect(providerActivityText('Connecting with token=sk-examplecredential12345')).toBe(
      'Connecting with token=[redacted]'
    )
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

  it.each([
    ['Auth with ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 done', 'Auth with [redacted] done'],
    [
      'Using github_pat_11ABCDEFG0abcdefghijklmnop_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123 now',
      'Using [redacted] now'
    ],
    ['Signing with AKIAIOSFODNN7EXAMPLE now', 'Signing with [redacted] now'],
    [
      'Session eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c ready',
      'Session [redacted] ready'
    ],
    [
      'Cloning https://user:hunter2secret@github.com/org/repo.git',
      'Cloning https://user:[redacted]@github.com/org/repo.git'
    ],
    [
      'Fetching https://api.example.com/v1/data?token=abcdefghijklmnop0123 now',
      'Fetching https://api.example.com/v1/data?token=[redacted] now'
    ]
  ])('redacts %s', (input, expected) => {
    expect(providerActivityText(input)).toBe(expected)
  })
})
