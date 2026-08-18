import { describe, expect, it } from 'vitest'
import { CODEX_APP_SERVER_NOTIFICATION_METHODS } from '../../codex/codex-app-server-notification-schema'
import { CLAUDE_STREAM_JSON_FRAME_KINDS } from './claude-stream-json-frame-schema'
import {
  classifyProviderFrame,
  isDeltaShapedProviderFrameKind,
  PROVIDER_FRAME_CLASSIFICATIONS
} from './provider-frame-disposition'

describe('provider frame classification catalog', () => {
  it('classifies every pinned Codex app-server notification method', () => {
    expect(Object.keys(PROVIDER_FRAME_CLASSIFICATIONS.codex)).toEqual([
      ...CODEX_APP_SERVER_NOTIFICATION_METHODS
    ])
  })

  it('classifies every pinned Claude stream-json frame kind', () => {
    expect(Object.keys(PROVIDER_FRAME_CLASSIFICATIONS.claude)).toEqual([
      ...CLAUDE_STREAM_JSON_FRAME_KINDS
    ])
  })

  it('classifies every pinned delta kind as stream-into-item', () => {
    const deltaKinds = [
      ...Object.keys(PROVIDER_FRAME_CLASSIFICATIONS.codex),
      ...Object.keys(PROVIDER_FRAME_CLASSIFICATIONS.claude)
    ].filter(isDeltaShapedProviderFrameKind)

    expect(deltaKinds.length).toBeGreaterThan(0)
    for (const kind of deltaKinds) {
      const provider = kind.startsWith('message:') ? 'claude' : 'codex'
      expect(classifyProviderFrame(provider, kind, {}), kind).toBe('stream-into-item')
    }
  })

  it('suppresses benign hook lifecycle and Codex progress frames', () => {
    expect(classifyProviderFrame('codex', 'notification:hook/started', {})).toBe(
      'suppressed-benign'
    )
    expect(classifyProviderFrame('codex', 'notification:hook/completed', {})).toBe(
      'suppressed-benign'
    )
    expect(classifyProviderFrame('codex', 'notification:account/rateLimits/updated', {})).toBe(
      'suppressed-benign'
    )
    expect(classifyProviderFrame('codex', 'notification:turn/diff/updated', {})).toBe(
      'suppressed-benign'
    )
    expect(classifyProviderFrame('claude', 'message:system:hook_started', {})).toBe(
      'suppressed-benign'
    )
  })

  it('promotes payload failures over a benign catalog classification', () => {
    expect(
      classifyProviderFrame('codex', 'notification:hook/completed', {
        run: { status: 'failed' }
      })
    ).toBe('error-surface')
    expect(
      classifyProviderFrame('claude', 'message:system:hook_response', {
        outcome: 'error',
        stderr: 'hook failed'
      })
    ).toBe('error-surface')
  })

  it('keeps unknown future frames on the substantive bounded fallback path', () => {
    expect(classifyProviderFrame('codex', 'notification:future/event', {})).toBe(
      'timeline-substantive'
    )
    expect(classifyProviderFrame('claude', 'message:future_event', {})).toBe('timeline-substantive')
  })

  it('structurally diverts unknown future delta kinds from generic rows', () => {
    expect(classifyProviderFrame('codex', 'notification:item/newThing/outputDelta', {})).toBe(
      'stream-into-item'
    )
    expect(classifyProviderFrame('claude', 'message:future_delta', {})).toBe('stream-into-item')
  })

  it('dispositions codex item-form frames, which the method catalog never matches', () => {
    // `thread/compacted` is already chrome; its item form is the same event and
    // must not leak `codex · item:contextCompaction` into the transcript.
    expect(classifyProviderFrame('codex', 'item:contextCompaction', {})).toBe('status-chrome')
    expect(classifyProviderFrame('codex', 'notification:thread/compacted', {})).toBe(
      'status-chrome'
    )
    // An item type nobody has dispositioned still falls through visibly.
    expect(classifyProviderFrame('codex', 'item:futureThing', {})).toBe('timeline-substantive')
  })
})
