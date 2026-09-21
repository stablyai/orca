import { describe, expect, it } from 'vitest'
import { CODEX_APP_SERVER_NOTIFICATION_METHODS } from '../../codex/codex-app-server-notification-schema'
import { CLAUDE_STREAM_JSON_FRAME_KINDS } from './claude-stream-json-frame-schema'
import {
  classifyProviderFrame,
  isDeltaShapedProviderFrameKind,
  PROVIDER_FRAME_CLASSIFICATIONS
} from './provider-frame-disposition'
import { unhandledProviderFrameJournalItem } from './unhandled-provider-frame'

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

  it('keeps command queue bookkeeping off the transcript without hiding a failed one', () => {
    expect(
      classifyProviderFrame('claude', 'message:command_lifecycle', {
        command_uuid: 'command-1',
        state: 'started'
      })
    ).toBe('status-chrome')
    expect(
      classifyProviderFrame('claude', 'message:command_lifecycle', {
        command_uuid: 'command-1',
        state: 'cancelled'
      })
    ).toBe('status-chrome')
    // Payload inspection outranks the catalogue, so suppressing the kind cannot
    // swallow a state the provider reports as a failure.
    expect(
      classifyProviderFrame('claude', 'message:command_lifecycle', {
        command_uuid: 'command-1',
        state: 'failed'
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
    // Both provider generations reach the journal's compaction deduplication.
    expect(classifyProviderFrame('codex', 'item:contextCompaction', {})).toBe(
      'timeline-substantive'
    )
    expect(classifyProviderFrame('codex', 'notification:thread/compacted', {})).toBe(
      'timeline-substantive'
    )
    // An item type nobody has dispositioned still falls through visibly.
    expect(classifyProviderFrame('codex', 'item:futureThing', {})).toBe('timeline-substantive')
  })

  it('chromes the one unmodelled codex item type that carries no content', () => {
    expect(classifyProviderFrame('codex', 'item:sleep', { id: 's', durationMs: 20_000 })).toBe(
      'status-chrome'
    )
    // Payload inspection still outranks the item catalog, so chroming a type
    // cannot swallow one that reports a failure.
    expect(classifyProviderFrame('codex', 'item:sleep', { id: 's', status: 'failed' })).toBe(
      'error-surface'
    )
  })

  it('suppresses subAgentActivity once the roster renders it, but never collabAgentToolCall', () => {
    expect(
      classifyProviderFrame('codex', 'item:subAgentActivity', {
        id: 'a-1',
        kind: 'started',
        agentThreadId: 'thread-child',
        agentPath: '/root/list_directory'
      })
      // The spawn-group roster row renders this now, so a raw gray row beside it
      // would duplicate it. Suppressing it was gated on that renderer existing.
    ).toBe('status-chrome')
    expect(
      classifyProviderFrame('codex', 'item:collabAgentToolCall', {
        id: 'c-1',
        tool: 'spawn',
        status: 'inProgress',
        senderThreadId: 'thread-root',
        receiverThreadIds: ['thread-child'],
        agentsStates: {}
      })
    ).toBe('timeline-substantive')
  })

  it('leaves content-bearing codex item types on the visible fallback', () => {
    // Each carries text or a path a user would want: review output, the image
    // the agent looked at or generated, injected hook prompt text.
    for (const type of [
      'imageView',
      'imageGeneration',
      'enteredReviewMode',
      'exitedReviewMode',
      'hookPrompt'
    ]) {
      expect(classifyProviderFrame('codex', `item:${type}`, { id: 'i' }), type).toBe(
        'timeline-substantive'
      )
    }
  })
})

describe('notice disposition boundaries', () => {
  it.each(['warning', 'guardianWarning', 'deprecationNotice', 'configWarning'])(
    'retains the error-surface cap exemption for %s',
    (method) => {
      expect(classifyProviderFrame('codex', `notification:${method}`, {})).toBe('error-surface')
    }
  )
  it('does not change usage or rate-limit classifications', () => {
    expect(classifyProviderFrame('codex', 'thread/tokenUsage/updated', {})).toBe('status-chrome')
    expect(classifyProviderFrame('codex', 'account/rateLimits/updated', {})).toBe(
      'suppressed-benign'
    )
  })
})

describe('codex subagent item disposition', () => {
  it('keeps subagent lifecycle out of the transcript now that it renders as a roster row', () => {
    expect(
      classifyProviderFrame('codex', 'item:subAgentActivity', {
        type: 'subAgentActivity',
        kind: 'started',
        agentThreadId: 'child-1',
        agentPath: '/root/read'
      })
    ).toBe('status-chrome')
  })

  it('leaves collab tool calls substantive — they may be the only subagent signal', () => {
    // A session that reports no `subAgentActivity` gets no roster row, so
    // suppressing this too would render its fan-out blank.
    expect(
      classifyProviderFrame('codex', 'item:collabAgentToolCall', {
        type: 'collabAgentToolCall',
        agentsStates: {}
      })
    ).not.toBe('status-chrome')
  })

  it('journals no fallback row for subagent activity', () => {
    expect(
      unhandledProviderFrameJournalItem('codex', 'item:subAgentActivity', {
        kind: 'completed',
        agentThreadId: 'child-1'
      })
    ).toBeNull()
  })

  it('still surfaces a subagent frame that reports a failure', () => {
    expect(
      classifyProviderFrame('codex', 'item:collabAgentToolCall', {
        type: 'collabAgentToolCall',
        status: 'failed'
      })
    ).toBe('error-surface')
  })
})
