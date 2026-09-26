/**
 * Events OpenCode 2.0.14 handed a plugin's setup() subscription, captured in order from a live
 * run against a mock provider. Only the fields the status plugin reads are kept; the dropped
 * events (text deltas, usage, shell and tool-input bookkeeping) carry no session lifecycle.
 */
export type OpenCode2CapturedEvent = { type: string; data: Record<string, unknown> }

export const OPENCODE2_TURN_ENDING_CAPTURES = {
  /** A provider 400 ends the turn: a failed step, then the failed execution. */
  providerError: [
    { type: 'session.created', data: { sessionID: 'ses_root' } },
    { type: 'session.inbox.enqueued', data: { sessionID: 'ses_root' } },
    { type: 'session.execution.started', data: { sessionID: 'ses_root' } },
    { type: 'session.step.started', data: { sessionID: 'ses_root' } },
    {
      type: 'session.step.failed',
      data: {
        sessionID: 'ses_root',
        error: {
          type: 'provider.invalid-request',
          message: 'QA mock: this request was rejected (400).',
          status: 400
        }
      }
    },
    {
      type: 'session.execution.failed',
      data: {
        sessionID: 'ses_root',
        error: {
          type: 'provider.invalid-request',
          message: 'QA mock: this request was rejected (400).',
          status: 400
        }
      }
    }
  ],
  /** Escape twice while text streams: the step fails as aborted, the execution is interrupted by the user. */
  escapeMidStream: [
    { type: 'session.inbox.enqueued', data: { sessionID: 'ses_root' } },
    { type: 'session.execution.started', data: { sessionID: 'ses_root' } },
    { type: 'session.step.started', data: { sessionID: 'ses_root' } },
    { type: 'session.text.started', data: { sessionID: 'ses_root' } },
    { type: 'session.text.ended', data: { sessionID: 'ses_root' } },
    {
      type: 'session.step.failed',
      data: { sessionID: 'ses_root', error: { type: 'aborted', message: 'Step interrupted' } }
    },
    { type: 'session.execution.interrupted', data: { sessionID: 'ses_root', reason: 'user' } }
  ],
  /** Escape twice while a shell tool runs: the tool and step fail as aborted, then the user interrupt. */
  escapeDuringTool: [
    { type: 'session.inbox.enqueued', data: { sessionID: 'ses_root' } },
    { type: 'session.execution.started', data: { sessionID: 'ses_root' } },
    { type: 'session.step.started', data: { sessionID: 'ses_root' } },
    { type: 'session.tool.called', data: { sessionID: 'ses_root' } },
    { type: 'session.tool.progress', data: { sessionID: 'ses_root' } },
    {
      type: 'session.tool.failed',
      data: {
        sessionID: 'ses_root',
        error: { type: 'aborted', message: 'Tool execution interrupted' }
      }
    },
    {
      type: 'session.step.failed',
      data: { sessionID: 'ses_root', error: { type: 'aborted', message: 'Step interrupted' } }
    },
    { type: 'session.execution.interrupted', data: { sessionID: 'ses_root', reason: 'user' } }
  ],
  /** Context overflow whose compaction is rejected: the turn fails. */
  overflowCompactionRejected: [
    { type: 'session.inbox.enqueued', data: { sessionID: 'ses_root' } },
    { type: 'session.execution.started', data: { sessionID: 'ses_root' } },
    { type: 'session.compaction.started', data: { sessionID: 'ses_root', reason: 'auto' } },
    {
      type: 'session.compaction.failed',
      data: {
        sessionID: 'ses_root',
        reason: 'auto',
        error: {
          type: 'compaction.failed',
          message: 'Compaction summary did not match the required template'
        }
      }
    },
    { type: 'session.step.started', data: { sessionID: 'ses_root' } },
    {
      type: 'session.step.failed',
      data: {
        sessionID: 'ses_root',
        error: {
          type: 'provider.invalid-request',
          message: 'prompt is too long: 250000 tokens > 200000 maximum',
          status: 400
        }
      }
    },
    {
      type: 'session.execution.failed',
      data: {
        sessionID: 'ses_root',
        error: {
          type: 'provider.invalid-request',
          message: 'prompt is too long: 250000 tokens > 200000 maximum',
          status: 400
        }
      }
    }
  ],
  /** Context overflow recovered by compaction: no failure event reaches the plugin. */
  overflowCompactionSucceeded: [
    { type: 'session.inbox.enqueued', data: { sessionID: 'ses_root' } },
    { type: 'session.execution.started', data: { sessionID: 'ses_root' } },
    { type: 'session.compaction.started', data: { sessionID: 'ses_root', reason: 'auto' } },
    { type: 'session.compaction.ended', data: { sessionID: 'ses_root', reason: 'auto' } },
    { type: 'session.step.started', data: { sessionID: 'ses_root' } },
    { type: 'session.text.started', data: { sessionID: 'ses_root' } },
    { type: 'session.text.ended', data: { sessionID: 'ses_root' } },
    { type: 'session.step.ended', data: { sessionID: 'ses_root', finish: 'stop' } },
    { type: 'session.execution.succeeded', data: { sessionID: 'ses_root' } }
  ],
  /** The root fails while its background child runs; the child's finish wakes the root, which fails again. */
  rootFailsWhileChildRuns: [
    { type: 'session.inbox.enqueued', data: { sessionID: 'ses_root' } },
    { type: 'session.execution.started', data: { sessionID: 'ses_root' } },
    { type: 'session.step.started', data: { sessionID: 'ses_root' } },
    { type: 'session.tool.called', data: { sessionID: 'ses_root' } },
    { type: 'session.created', data: { sessionID: 'ses_child', parentID: 'ses_root' } },
    { type: 'session.tool.progress', data: { sessionID: 'ses_root' } },
    { type: 'session.inbox.enqueued', data: { sessionID: 'ses_child' } },
    { type: 'session.tool.success', data: { sessionID: 'ses_root' } },
    { type: 'session.execution.started', data: { sessionID: 'ses_child' } },
    { type: 'session.step.ended', data: { sessionID: 'ses_root', finish: 'tool-calls' } },
    { type: 'session.step.started', data: { sessionID: 'ses_root' } },
    { type: 'session.step.started', data: { sessionID: 'ses_child' } },
    { type: 'session.tool.called', data: { sessionID: 'ses_child' } },
    { type: 'session.tool.progress', data: { sessionID: 'ses_child' } },
    {
      type: 'session.step.failed',
      data: {
        sessionID: 'ses_root',
        error: {
          type: 'provider.invalid-request',
          message: 'QA mock: the root follow-up request was rejected (400).',
          status: 400
        }
      }
    },
    {
      type: 'session.execution.failed',
      data: {
        sessionID: 'ses_root',
        error: {
          type: 'provider.invalid-request',
          message: 'QA mock: the root follow-up request was rejected (400).',
          status: 400
        }
      }
    },
    { type: 'session.tool.success', data: { sessionID: 'ses_child' } },
    { type: 'session.step.ended', data: { sessionID: 'ses_child', finish: 'tool-calls' } },
    { type: 'session.step.started', data: { sessionID: 'ses_child' } },
    { type: 'session.text.started', data: { sessionID: 'ses_child' } },
    { type: 'session.text.ended', data: { sessionID: 'ses_child' } },
    { type: 'session.step.ended', data: { sessionID: 'ses_child', finish: 'stop' } },
    { type: 'session.execution.succeeded', data: { sessionID: 'ses_child' } },
    { type: 'session.inbox.enqueued', data: { sessionID: 'ses_root' } },
    { type: 'session.execution.started', data: { sessionID: 'ses_root' } },
    { type: 'session.step.started', data: { sessionID: 'ses_root' } },
    {
      type: 'session.step.failed',
      data: {
        sessionID: 'ses_root',
        error: {
          type: 'provider.invalid-request',
          message: 'QA mock: the root follow-up request was rejected (400).',
          status: 400
        }
      }
    },
    {
      type: 'session.execution.failed',
      data: {
        sessionID: 'ses_root',
        error: {
          type: 'provider.invalid-request',
          message: 'QA mock: the root follow-up request was rejected (400).',
          status: 400
        }
      }
    }
  ]
} satisfies Record<string, OpenCode2CapturedEvent[]>
