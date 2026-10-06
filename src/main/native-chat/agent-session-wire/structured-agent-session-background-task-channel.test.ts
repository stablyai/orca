// The strip channel always answers a conversation's roster from the host's child records; each
// subscriber's frames carry it (see structured-agent-session-subscribers.test.ts).

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
  stops: () => Stops = () => ({ supportsTaskStop: true, supportsStopAll: true })
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
    children
  )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the map reads only the journal's commit observer and the session's provider.
  const session = {
    journal: { observeCommits: () => {} },
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

  // A task that finished while no pane listened, then an idle sweep that stopped the provider:
  // a pane resuming must read "none", not silence it would take as "unchanged" (#24227).
  it('answers "none" for a conversation no provider holds, not "unknown"', () => {
    const { sessions, channel, session } = channelOver(
      () => [],
      () => undefined
    )
    sessions.set('session-1', session)

    expect(channel.read('session-1')).toBeNull()
  })

  // Claude's release path settles the last child after the adapter let go of the session, so no
  // provider answers for it any more: the strip must still hide.
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
