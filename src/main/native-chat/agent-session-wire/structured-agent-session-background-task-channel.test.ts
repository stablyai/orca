import { describe, expect, it, vi } from 'vitest'
import type { AgentChildWorkView } from '../../../shared/agent-status/child-work/agent-status-child-work-view'
import { StructuredAgentSessionBackgroundTaskChannel } from './publication/subscribers/structured-agent-session-background-task-channel'
import { StructuredAgentSessionConversations } from './host/structured-agent-session-conversations'
import type {
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession
} from './host/structured-agent-session-host-types'
import type { AgentSessionSubscribers } from './publication/subscribers/structured-agent-session-subscribers'
import { recordingStructuredAgentSessionLogger } from './host/testing/structured-agent-session-logger-test-support'

const child: AgentChildWorkView = {
  id: 'child-1',
  providerId: 'task-1',
  kind: 'agent',
  state: 'working',
  membership: 'live',
  firstObservedAt: 1,
  observedAt: 1,
  stoppable: true,
  invocation: { invocationId: 'spawn-1', generation: 1 }
}

type Stops = { supportsTaskStop: boolean; supportsStopAll: boolean } | undefined

function channelOver(
  children: () => AgentChildWorkView[] = () => [child],
  stops: () => Stops = () => ({ supportsTaskStop: true, supportsStopAll: true }),
  incomplete: () => boolean = () => false
) {
  const sessions = new StructuredAgentSessionConversations({
    deliver: () => {},
    logger: recordingStructuredAgentSessionLogger().logger,
    now: () => 1
  })
  const republished = vi.fn()
  const channel = new StructuredAgentSessionBackgroundTaskChannel(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the channel reads only the record store's fence and the adapter's stop capability.
    {
      store: { getConversation: () => null },
      adapter: { backgroundTaskStops: stops }
    } as unknown as StructuredAgentSessionHostDeps,
    sessions,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: publish sends through `republishBackgroundTasks` only.
    { republishBackgroundTasks: republished } as unknown as AgentSessionSubscribers,
    async () => {
      throw new Error('not opened here')
    },
    children,
    incomplete
  )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the map reads only the journal's commit observer and the session's provider.
  const session = {
    journal: { observeCommits: () => {}, stopMarks: { observeSettleEdges: () => {} } },
    params: { provider: 'claude' }
  } as unknown as StructuredAgentSessionHostSession
  return { sessions, republished, channel, session }
}

describe('the background-task channel', () => {
  it('retains a completed agent for inspection after the provider lets go of the session', () => {
    let views: AgentChildWorkView[] = [child]
    let held: Stops = { supportsTaskStop: true, supportsStopAll: true }
    const { sessions, channel, session } = channelOver(
      () => views,
      () => held
    )
    sessions.set('session-1', session)
    expect(channel.read('session-1')?.children).toHaveLength(1)

    held = undefined
    views = [{ ...child, state: 'done', membership: 'settled', outcome: 'unknown', settledAt: 2 }]
    expect(channel.read('session-1')).toMatchObject({
      children: views,
      supportsStopAll: false,
      settledTasks: [expect.objectContaining({ id: 'task-1' })]
    })
  })
})
