import { describe, expect, it } from 'vitest'
import type { AgentChildWorkView } from '../../../../../shared/agent-status/child-work/agent-status-child-work-view'

import { structuredSessionBackgroundTasksView } from '../../../../../shared/structured-session-background-tasks-view'
import {
  attach,
  hostTestState,
  serveHostTestChildWork
} from './structured-agent-session-host-test-harness'
import { HOST_TEST_SESSION as SESSION } from './structured-agent-session-host-test-data'

function running(id: string, over: Partial<AgentChildWorkView> = {}): AgentChildWorkView {
  return {
    id,
    kind: 'agent',
    state: 'working',
    membership: 'live',
    firstObservedAt: 1,
    observedAt: 1,
    stoppable: false,
    invocation: { invocationId: `spawn-${id}`, generation: 1 },
    ...over
  }
}

function finished(id: string, settledAt: number): AgentChildWorkView {
  return running(id, {
    state: 'done',
    membership: 'settled',
    outcome: 'succeeded',
    observedAt: settledAt,
    settledAt
  })
}

const ids = (views: readonly AgentChildWorkView[]) => views.map((view) => view.id)

describe('the host retains child history while summaries report running work', () => {
  it('retains settled children for inspection without adding them to live summaries', async () => {
    let records = [
      finished('done', 5),
      running('run'),
      finished('owner', 6),
      running('shell', { kind: 'command', parentChildWorkId: 'owner' })
    ]
    serveHostTestChildWork(() => records)
    await attach()
    const { host } = hostTestState()
    const strip = async () => {
      const page = await host.history({ sessionId: SESSION, direction: 'tail' })
      return page.ok ? page.page.backgroundTasks : undefined
    }
    expect(ids((await strip())?.children ?? [])).toEqual(['done', 'run', 'owner', 'shell'])
    const summaries: string[][] = []
    host.subscribeStatus({
      id: 'list',
      emit: (event) => {
        if (event.type === 'snapshot') {
          summaries.push(event.sessions.flatMap((session) => ids(session.children ?? [])))
        }
      }
    })
    expect(summaries.at(-1)).toEqual(['run', 'owner', 'shell'])

    records = [finished('done', 5), finished('run', 7)]
    host.publishChildWorkEvidence(SESSION, [])
    await host.flushStreamedEvents(SESSION)
    const retained = await strip()
    expect(ids(retained?.children ?? [])).toEqual(['done', 'run'])
    expect(ids(host.readStatusSummary(SESSION)?.children ?? [])).toEqual([])
    expect(structuredSessionBackgroundTasksView(retained, null)).toMatchObject({
      show: true,
      isMonitoring: false,
      offersStopAll: false
    })
  })
})
