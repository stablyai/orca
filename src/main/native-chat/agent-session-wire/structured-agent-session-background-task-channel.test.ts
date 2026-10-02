// The strip channel keeps one fingerprint per conversation to skip an unchanged roster; a closed
// conversation's goes with it.

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
  const sent = vi.fn()
  const channel = new StructuredAgentSessionBackgroundTaskChannel(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the channel reads only the record store's fence and the adapter's stop capability.
    {
      store: { getRecord: () => null },
      adapter: { backgroundTaskStops: stops }
    } as unknown as StructuredAgentSessionHostDeps,
    sessions,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: publish sends through `backgroundTasks` only.
    { backgroundTasks: sent } as unknown as AgentSessionSubscribers,
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
  return { sessions, sent, channel, session }
}

describe('the background-task channel', () => {
  it("forgets a closed conversation's roster, so reopening it sends the roster again", () => {
    const { sessions, sent, channel, session } = channelOver()
    sessions.set('session-1', session)
    channel.publish('session-1')
    channel.publish('session-1')
    // An unchanged roster sends nothing.
    expect(sent).toHaveBeenCalledTimes(1)

    sessions.delete('session-1')
    expect(channel['published'].size).toBe(0)
    sessions.set('session-1', session)
    channel.publish('session-1')
    expect(sent).toHaveBeenCalledTimes(2)
  })

  it('sends "no children" once, not again on every change that leaves none', () => {
    let views: AgentChildWorkView[] = []
    const { sessions, sent, channel, session } = channelOver(() => views)
    sessions.set('session-1', session)
    channel.publish('session-1')
    channel.publish('session-1')
    expect(sent.mock.calls.map(([, state]) => state)).toEqual([null])

    views = [child]
    channel.publish('session-1')
    views = []
    channel.publish('session-1')
    channel.publish('session-1')
    expect(sent.mock.calls.map(([, state]) => state?.children?.length ?? null)).toEqual([
      null,
      1,
      null
    ])
  })

  // Claude's release path settles the last child after the adapter let go of the session, so no
  // provider answers for it any more: the strip must still hide.
  it('hides the strip when its last child settles after the provider let go of the session', () => {
    let views: AgentChildWorkView[] = [child]
    let held: Stops = { supportsTaskStop: true, supportsStopAll: true }
    const { sessions, sent, channel, session } = channelOver(
      () => views,
      () => held
    )
    sessions.set('session-1', session)
    channel.publish('session-1')
    expect(sent.mock.calls.at(-1)?.[1]?.children).toHaveLength(1)

    held = undefined
    views = [{ ...child, state: 'done', membership: 'settled', outcome: 'unknown', settledAt: 2 }]
    channel.publish('session-1')
    expect(sent.mock.calls.at(-1)?.[1]).toBeNull()
  })
})
