import { describe, expect, it } from 'vitest'
import { classifyProviderFrame } from '../provider-frame-disposition'
import { unhandledProviderFrameJournalItem } from '../unhandled-provider-frame'

describe('provider frame classification catalog', () => {
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

  it('structurally diverts unknown future delta kinds from generic rows', () => {
    expect(classifyProviderFrame('codex', 'notification:item/newThing/outputDelta', {})).toBe(
      'stream-into-item'
    )
    expect(classifyProviderFrame('claude', 'message:future_delta', {})).toBe('stream-into-item')
  })

  it('suppresses subAgentActivity once the roster renders it, but never collabAgentToolCall', () => {
    expect(
      classifyProviderFrame('codex', 'item:subAgentActivity', {
        id: 'a-1',
        kind: 'started',
        agentThreadId: 'thread-child',
        agentPath: '/root/list_directory'
      })
      // The roster already renders this lifecycle; raw fallback would duplicate it.
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
})

describe('failure is decided by kind, never by searching the payload', () => {
  it('writes no row for a Claude session start that lists MCP servers which failed to connect', () => {
    // Captured Claude 2.1.289 init includes failed MCP servers, not a failed session (#25477).
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
    expect(unhandledProviderFrameJournalItem('claude', 'message:system:future', failed)).toBeNull()
  })
})
