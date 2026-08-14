import { describe, expect, it } from 'vitest'
import { projectStructuredItemToNativeChat } from '../../../shared/structured-agent-session-projection'
import { unhandledProviderFrameJournalItem } from './unhandled-provider-frame'

describe('unhandled provider frame journal fallback', () => {
  it('keeps a compact label and bounds the expandable payload without dropping it', () => {
    const item = unhandledProviderFrameJournalItem(
      'future-provider',
      'notification:new/event',
      { body: 'abcdefghij' },
      {
        inlineHeadBytes: 8,
        maxSessionBytes: 1024,
        maxAppendsPerWindow: 10,
        appendWindowMs: 1000
      }
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
    expect(item.blobs).toEqual([
      {
        digest: item.body.providerFrame?.payload.digest,
        payload: '{"body":"abcdefghij"}'
      }
    ])
  })

  it('turns an unserializable payload into an explicit visible value', () => {
    const cyclic: { self?: unknown } = {}
    cyclic.self = cyclic

    const item = unhandledProviderFrameJournalItem('codex', 'frame', cyclic)

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
    expect(
      unhandledProviderFrameJournalItem('codex', 'notification:thread/goal/cleared', {})
    ).toBeNull()
    expect(unhandledProviderFrameJournalItem('claude', 'message:system:init', {})).toBeNull()
    expect(
      unhandledProviderFrameJournalItem('claude', 'message:result', {
        subtype: 'success',
        is_error: false
      })
    ).toBeNull()
  })

  it('renders codex systemError and Claude error result variants', () => {
    const codex = unhandledProviderFrameJournalItem('codex', 'notification:thread/status/changed', {
      threadId: 'thread-1',
      status: { type: 'systemError' }
    })
    const claude = unhandledProviderFrameJournalItem('claude', 'message:result', {
      subtype: 'error_during_execution',
      is_error: true,
      result: 'Provider request failed'
    })

    expect(codex?.body.providerFrame).toMatchObject({
      provider: 'codex',
      kind: 'notification:thread/status/changed'
    })
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

  it('keeps failed startup variants visible while suppressing startup progress', () => {
    const kind = 'notification:mcpServer/startupStatus/updated'

    expect(
      unhandledProviderFrameJournalItem('codex', kind, {
        name: 'filesystem',
        status: 'starting',
        error: null,
        failureReason: null
      })
    ).toBeNull()
    expect(
      unhandledProviderFrameJournalItem('codex', kind, {
        name: 'filesystem',
        status: 'failed',
        error: 'server exited',
        failureReason: null
      })
    ).not.toBeNull()
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
})
