import { describe, expect, it } from 'vitest'
import {
  classifyProviderFrame,
  isDeltaProviderFrameKind,
  PROVIDER_FRAME_CLASSIFICATIONS
} from './provider-frame-disposition'
import { unhandledProviderFrameJournalItem } from './unhandled-provider-frame'

describe('provider frame classification catalog', () => {
  it('classifies every pinned delta kind as stream-into-item', () => {
    const deltaKinds = [
      ...Object.keys(PROVIDER_FRAME_CLASSIFICATIONS.codex),
      ...Object.keys(PROVIDER_FRAME_CLASSIFICATIONS.claude)
    ].filter(isDeltaProviderFrameKind)

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
    expect(classifyProviderFrame('claude', 'message:stream_event:ping', {})).toBe(
      'suppressed-benign'
    )
  })

  it("surfaces a failed hook from the hook's own outcome field", () => {
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

  it('surfaces a Claude authentication error from its declared field', () => {
    const failure = unhandledProviderFrameJournalItem('claude', 'message:auth_status', {
      type: 'auth_status',
      isAuthenticating: false,
      output: [],
      error: 'Login timed out'
    })
    expect(failure?.classification).toBe('error-surface')
    expect(failure?.body.text).toBe('Login timed out')
    expect(
      unhandledProviderFrameJournalItem('claude', 'message:auth_status', {
        type: 'auth_status',
        isAuthenticating: true,
        output: []
      })
    ).toBeNull()
  })

  it('keeps command queue bookkeeping off the transcript', () => {
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

describe('failure is decided by kind, never by searching the payload', () => {
  it('writes no row for a Claude session start that lists MCP servers which failed to connect', () => {
    // The roster as Claude Code 2.1.289 sends it (issue #25477): a failed server carries
    // only its status, and used to turn the whole session start into a red opcode card.
    const init = {
      type: 'system',
      subtype: 'init',
      mcp_servers: [
        { name: 'MCP_DOCKER', status: 'failed', source: 'user' },
        { name: 'codegraph', status: 'connected', source: 'user' },
        { name: 'jira', status: 'failed', source: 'user' }
      ]
    }
    expect(unhandledProviderFrameJournalItem('claude', 'message:system:init', init)).toBeNull()
  })

  it('never turns a nested failure-looking value into an error row', () => {
    const failed = { task_id: 't-1', status: 'failed', error: 'exit code 1' }
    expect(
      unhandledProviderFrameJournalItem('claude', 'message:system:task_notification', failed)
    ).toBeNull()
    expect(
      unhandledProviderFrameJournalItem('codex', 'notification:mcpServer/startupStatus/updated', {
        name: 'github',
        status: 'failed',
        error: 'auth expired'
      })
    ).toBeNull()
    // A kind nobody catalogued stays an ordinary fallback row, not a failure.
    const unknown = unhandledProviderFrameJournalItem('claude', 'message:system:future', failed)
    expect(unknown?.classification).toBe('timeline-substantive')
    expect(unknown?.body.tone).toBeUndefined()
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
})
