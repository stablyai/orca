import { describe, expect, it } from 'vitest'
import { projectStructuredItemToNativeChat } from '../../../shared/structured-agent-session-projection'
import { unhandledProviderFrameJournalItem } from './unhandled-provider-frame'

describe('unhandled provider frame journal fallback', () => {
  it('keeps a compact label and bounds the expandable payload without dropping it', () => {
    const item = unhandledProviderFrameJournalItem(
      'future-provider',
      'notification:new/event',
      { body: 'abcdefghij' },
      { inlineHeadBytes: 8 }
    )

    expect(item).not.toBeNull()
    if (!item) {
      throw new Error('expected substantive provider frame')
    }
    expect(item.body).toMatchObject({
      kind: 'status',
      text: 'future-provider · notification:new/event',
      providerFrame: {
        provider: 'future-provider',
        kind: 'notification:new/event',
        payload: { byteLength: 21, truncated: true }
      }
    })
    expect(
      Buffer.byteLength(item.body.providerFrame?.payload.head ?? '', 'utf8')
    ).toBeLessThanOrEqual(8)
  })

  it('turns an unserializable message-shaped payload into an explicit visible value', () => {
    const cyclic: { warning?: unknown } = {}
    cyclic.warning = cyclic

    const item = unhandledProviderFrameJournalItem('codex', 'frame', cyclic)

    expect(item?.body.text).toBe('codex · frame')
    expect(item?.body.providerFrame?.payload.head).toContain('unserializable payload')
  })

  it('routes provider lifecycle, startup, and status frames away from the timeline', () => {
    expect(unhandledProviderFrameJournalItem('codex', 'notification:thread/started', {})).toBeNull()
    expect(
      unhandledProviderFrameJournalItem('codex', 'notification:mcpServer/startupStatus/updated', {})
    ).toBeNull()
    expect(
      unhandledProviderFrameJournalItem('codex', 'notification:remoteControl/status/changed', {})
    ).toBeNull()
    expect(
      unhandledProviderFrameJournalItem('codex', 'notification:thread/tokenUsage/updated', {})
    ).toBeNull()
    expect(unhandledProviderFrameJournalItem('claude', 'message:system:init', {})).toBeNull()
    expect(
      unhandledProviderFrameJournalItem('claude', 'message:result', {
        subtype: 'success',
        is_error: false
      })
    ).toBeNull()
  })

  it('never creates generic rows for delta-shaped frames', () => {
    expect(
      unhandledProviderFrameJournalItem('codex', 'notification:item/commandExecution/outputDelta', {
        itemId: 'exec-1',
        delta: 'x'
      })
    ).toBeNull()
    expect(
      unhandledProviderFrameJournalItem('codex', 'notification:item/future/outputDelta', {
        itemId: 'future-1',
        delta: 'y'
      })
    ).toBeNull()
  })

  it('renders a Claude result frame that names no success as a failure row', () => {
    const claude = unhandledProviderFrameJournalItem('claude', 'message:result', {
      subtype: 'error_during_execution',
      is_error: true,
      result: 'Provider request failed'
    })

    expect(claude?.classification).toBe('error-surface')
    expect(claude?.body.providerFrame).toMatchObject({
      provider: 'claude',
      kind: 'message:result'
    })
    expect(
      claude
        ? projectStructuredItemToNativeChat({
            itemId: 'claude-error',
            revision: 1,
            sequence: 1,
            observedAt: 1,
            body: claude.body
          })
        : null
    ).toMatchObject({
      role: 'system',
      blocks: [
        expect.objectContaining({
          providerFrame: expect.objectContaining({ kind: 'message:result' })
        })
      ]
    })
  })

  it('surfaces a failed hook completion while suppressing successful hook lifecycle', () => {
    const kind = 'notification:hook/completed'

    expect(
      unhandledProviderFrameJournalItem('codex', kind, {
        run: { id: 'hook-1', status: 'completed' }
      })
    ).toBeNull()
    expect(
      unhandledProviderFrameJournalItem('codex', kind, {
        run: { id: 'hook-1', status: 'failed' }
      })
    ).not.toBeNull()
  })

  it('keeps unknown substantive frames visible for both providers', () => {
    expect(
      unhandledProviderFrameJournalItem('codex', 'notification:future/event', {})
    ).not.toBeNull()
    expect(unhandledProviderFrameJournalItem('claude', 'message:future/event', {})).not.toBeNull()
  })

  it("leads with a local slash command's output, which Claude sends as the frame's content", () => {
    expect(
      unhandledProviderFrameJournalItem('claude', 'message:system:local_command_output', {
        type: 'system',
        subtype: 'local_command_output',
        content: 'Session usage: 12% of your limit'
      })?.body.text
    ).toBe('Session usage: 12% of your limit')
    expect(
      unhandledProviderFrameJournalItem('claude', 'message:future/event', { content: 'raw' })?.body
        .text
    ).toBe('claude \u00b7 message:future/event')
  })

  it('leads with the provider sentence instead of naming the opcode', () => {
    const row = unhandledProviderFrameJournalItem('codex', 'notification:warning', {
      message: 'Your plan limit resets in 2 hours.'
    })
    expect(row?.body.text).toBe('Your plan limit resets in 2 hours.')
    expect(row?.body.providerFrame?.kind).toBe('notification:warning')
  })

  it('keeps the provider sentence whole while the raw frame keeps a head', () => {
    const message = 'abcdefghij'
    const row = unhandledProviderFrameJournalItem(
      'codex',
      'notification:warning',
      { message },
      { inlineHeadBytes: 8 }
    )

    expect(row?.body.text).toBe(message)
    expect(row?.body.providerFrame?.payload.truncated).toBe(true)
  })

  it('unwraps a nested sentence and falls back to the opcode when there is none', () => {
    expect(
      unhandledProviderFrameJournalItem('codex', 'notification:warning', {
        warning: { text: 'Sandbox is degraded.' }
      })?.body.text
    ).toBe('Sandbox is degraded.')
    expect(
      unhandledProviderFrameJournalItem('codex', 'notification:future/event', { count: 3 })?.body
        .text
    ).toBe('codex \u00b7 notification:future/event')
  })
})

describe('typed notice metadata', () => {
  it('publishes readable compaction statuses for both provider forms', () => {
    expect(
      unhandledProviderFrameJournalItem('codex', 'notification:thread/compacted', {})
    ).toMatchObject({
      classification: 'timeline-substantive',
      body: { kind: 'status', text: 'Context compacted', presentation: 'compaction' }
    })
    expect(unhandledProviderFrameJournalItem('codex', 'item:contextCompaction', {})).toMatchObject({
      body: { kind: 'status', text: 'Context compacted', presentation: 'compaction' }
    })
  })
  it.each([
    ['warning', { message: 'Check this' }, 'warning', 'Check this'],
    ['guardianWarning', { message: 'Review required' }, 'warning', 'Review required'],
    [
      'configWarning',
      { summary: 'Invalid option', details: 'Remove the option' },
      'warning',
      'Invalid option\n\nRemove the option'
    ],
    [
      'deprecationNotice',
      { summary: 'Old option', details: 'Use its replacement' },
      'notice',
      'Old option\n\nUse its replacement'
    ],
    ['error', { error: { message: 'Connection failed' } }, 'error', 'Connection failed']
  ])('assigns the tone and readable text for %s', (method, payload, tone, text) => {
    expect(
      unhandledProviderFrameJournalItem('codex', `notification:${method}`, payload)
    ).toMatchObject({
      classification: 'error-surface',
      body: { kind: 'status', text, tone }
    })
  })
})
