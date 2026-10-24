import { describe, expect, it, vi } from 'vitest'
import type { AgentChildWorkView } from '../../../shared/agent-status-child-work-view'
import { StructuredAgentSessionBackgroundTaskChannel } from './structured-agent-session-background-task-channel'
import { StructuredAgentSessionConversations } from './structured-agent-session-conversations'
import type {
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession
} from './structured-agent-session-host-types'
import type { AgentSessionSubscribers } from './structured-agent-session-subscribers'
import { recordingStructuredAgentSessionLogger } from './structured-agent-session-logger-test-support'

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
      store: { getRecord: () => null },
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
  it('lists running children with the stops the live provider offers', () => {
    const { sessions, channel, session } = channelOver()
    sessions.set('session-1', session)

    expect(channel.read('session-1')).toMatchObject({
      state: 'monitoring',
      supportsTaskStop: true,
      children: [child]
    })
  })

  // Unlisted live work must keep the strip incomplete and stoppable.
  it('keeps the strip, with its Stop, for work the host could not record', () => {
    const { sessions, channel, session } = channelOver(
      () => [],
      () => ({ supportsTaskStop: true, supportsStopAll: true }),
      () => true
    )
    sessions.set('session-1', session)

    expect(channel.read('session-1')).toEqual({
      state: 'monitoring',
      supportsTaskStop: true,
      children: [],
      incomplete: true
    })
  })

  it('answers "none" for a conversation no provider holds, not "unknown"', () => {
    const { sessions, channel, session } = channelOver(
      () => [],
      () => undefined
    )
    sessions.set('session-1', session)

    expect(channel.read('session-1')).toBeNull()
  })

  it('hides the strip when its last child settles after the provider let go of the session', () => {
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
    expect(channel.read('session-1')).toBeNull()
  })

  it('republishes only for an open conversation', () => {
    const { sessions, republished, channel, session } = channelOver()
    channel.publish('session-1')
    expect(republished).not.toHaveBeenCalled()

    sessions.set('session-1', session)
    channel.publish('session-1')
    expect(republished).toHaveBeenCalledWith('session-1', expect.any(Number))
  })
})
