import { describe, expect, it } from 'vitest'
import { OPENCODE_ACP_DIALECT } from '../acp-dialects/opencode-dialect'
import { AcpTimelineTranslator } from './acp-timeline-translator'

const child = { rootSessionId: 'root', childSessionId: 'child', parentSessionId: 'root' }

describe('OpenCode child sessions', () => {
  it('ends a failed child with its error as the last message', () => {
    const lane = new AcpTimelineTranslator({ sessionId: 'root', dialect: OPENCODE_ACP_DIALECT })
    lane.openPrompt('prompt-1', 1)
    const report = (params: Record<string, unknown>, at: number): void => {
      lane.notification('opencode/session/child_update', { ...child, ...params }, at)
    }
    report({ type: 'status', status: 'created' }, 2)
    report({ type: 'status', status: 'running' }, 3)
    report(
      {
        type: 'status',
        status: 'failed',
        error: {
          type: 'provider.rate-limit',
          message: 'Rate limit reached;\ntry again.',
          status: 429
        }
      },
      4
    )
    expect(lane.subagents.drainEvidence().filter((e) => e.type === 'ended')).toEqual([
      expect.objectContaining({ outcome: 'failed', lastMessage: 'Rate limit reached; try again.' })
    ])
  })

  // Recorded in opencode-v2-subagent-rerun.jsonl: OpenCode reruns one child session under the same id.
  it("ends each run with that run's own reply, never an earlier run's", () => {
    const lane = new AcpTimelineTranslator({ sessionId: 'root', dialect: OPENCODE_ACP_DIALECT })
    lane.openPrompt('prompt-1', 1)
    const report = (params: Record<string, unknown>, at: number): void => {
      lane.notification('opencode/session/child_update', { ...child, ...params }, at)
    }
    const says = (messageId: string, text: string, at: number): void => {
      report(
        {
          type: 'update',
          update: {
            sessionUpdate: 'agent_message_chunk',
            messageId,
            content: { type: 'text', text }
          }
        },
        at
      )
    }
    const tool = (toolCallId: string, at: number): void => {
      report(
        {
          type: 'update',
          update: { sessionUpdate: 'tool_call', toolCallId, title: 'sleep', status: 'pending' }
        },
        at
      )
    }
    report({ type: 'status', status: 'created' }, 2)
    report({ type: 'status', status: 'running' }, 3)
    says('msg-1', 'Checking first.', 4)
    tool('call-1', 5)
    says('msg-2', 'FIR', 6)
    says('msg-2', 'ST', 7)
    report({ type: 'status', status: 'completed' }, 8)
    report({ type: 'status', status: 'running' }, 9)
    says('msg-3', 'Looking again.', 10)
    tool('call-2', 11)
    report({ type: 'status', status: 'completed' }, 12)
    report({ type: 'status', status: 'running' }, 13)
    // One OpenCode message can continue after a tool call; its row holds both parts.
    says('msg-4', 'Checking. ', 14)
    tool('call-3', 15)
    says('msg-4', 'THIRD', 16)
    report({ type: 'status', status: 'completed' }, 17)

    const evidence = lane.subagents.drainEvidence()
    const ended = evidence.flatMap((edge) => (edge.type === 'ended' ? [edge] : []))
    expect(ended.map(({ outcome, lastMessage }) => ({ outcome, lastMessage }))).toEqual([
      { outcome: 'succeeded', lastMessage: 'FIRST' },
      { outcome: 'succeeded', lastMessage: undefined },
      { outcome: 'succeeded', lastMessage: 'Checking. THIRD' }
    ])
    // The host keys a saved reply by run, so each run needs its own handle.
    const runs = ended.map((edge) => edge.handle.runId)
    expect(new Set(runs).size).toBe(3)
    expect(runs).not.toContain(undefined)

    // A reattached lane that sees no start must not claim a new run for a child that already ended.
    const reattached = new AcpTimelineTranslator({
      sessionId: 'root',
      dialect: OPENCODE_ACP_DIALECT
    })
    reattached.openPrompt('prompt-2', 20)
    reattached.notification(
      'opencode/session/child_update',
      {
        ...child,
        type: 'update',
        update: { sessionUpdate: 'tool_call', toolCallId: 'late', title: 'x' }
      },
      21
    )
    const late = reattached.subagents.drainEvidence()
    expect(late.map((edge) => (edge.type === 'live' ? edge.child.handle.runId : 'other'))).toEqual([
      undefined
    ])
  })
})
