import { describe, expect, it } from 'vitest'
import type { AgentChildWorkView } from '../../../shared/agent-status-child-work-view'
import { structuredRunningChildWork } from '../../../shared/agent-child-work-listing'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { structuredAgentSessionAgentStatus } from '../../../shared/structured-agent-session-agent-status'
import {
  attach,
  hostTestState,
  serveHostTestChildWork
} from './structured-agent-session-host-test-harness'
import {
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD
} from './structured-agent-session-host-test-data'

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

describe('the sidebar and the strip list running children only', () => {
  it('drops finished and failed children, and keeps a finished one whose shell still runs', () => {
    const failed = { ...finished('failed', 5), outcome: 'failed' as const }
    const views = [
      running('working'),
      finished('done', 4),
      failed,
      finished('owner', 3),
      running('shell', { kind: 'command', parentChildWorkId: 'owner' })
    ]
    expect(ids(structuredRunningChildWork(views))).toEqual(['working', 'owner', 'shell'])
  })
})

describe("the host's strip channel and summary list the same running children", () => {
  it('sends both the running children, and the strip nothing once none runs', async () => {
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
    expect(ids((await strip())?.children ?? [])).toEqual(['run', 'owner', 'shell'])
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
    expect(await strip()).toBeNull()
  })
})

describe('a session list reads the main agent apart from its subagents', () => {
  it('as done once its turn ends while only a subagent still runs', async () => {
    let records: AgentChildWorkView[] = []
    serveHostTestChildWork(() => records)
    await attach()
    const { host, acquire } = hostTestState()
    const turn = { provider: 'codex' as const, threadId: THREAD, turnId: 'turn-1', ordinal: 1 }
    for (const state of ['running', 'completed'] as const) {
      acquire.mock.calls
        .at(-1)?.[0]
        .events?.appendItem(
          turn,
          { kind: 'turn', turnId: 'turn-1', state },
          { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
        )
    }
    records = [running('subagent')]
    host.publishChildWorkEvidence(SESSION, [])
    await host.flushStreamedEvents(SESSION)

    const summary = host.readStatusSummary(SESSION)!
    const row = structuredAgentSessionAgentStatus({
      ...summary,
      status: summary.status!,
      childWork: summary.children
    })
    expect({ mainAgent: row.mainAgent.state, row: row.state }).toEqual({
      mainAgent: 'done',
      row: 'working'
    })
  })
})
