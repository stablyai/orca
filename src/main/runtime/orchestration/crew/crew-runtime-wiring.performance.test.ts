import { expect, it } from 'vitest'
import { HEADLESS_RUNTIME_WINDOW_ID } from '../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import type { OrchestrationCrewFrame } from '../../../../shared/orchestration/orchestration-crew'
import { AgentHookServer } from '../../../agent-hooks/server/agent-hook-server'
import { OrcaRuntimeService } from '../../orca-runtime'
import { partialRuntimeStore } from '../../construction/test-context/runtime-store-partial-fixture'
import { subscribeCrew } from './crew-stream'
import { OrchestrationDb } from '../db/orchestration-db'

const WT = 'repo-1::/tmp/worktree-a'
const LEAF = '22222222-2222-4222-8222-222222222222'

const flush = async () => {
  for (let i = 0; i < 6; i++) {
    await Promise.resolve()
  }
}

/** A renderer graph publish of one tab: the runtime rewrites its terminal records for each. */
function graph(title: string) {
  return {
    tabs: [{ tabId: 'tab-1', worktreeId: WT, title, activeLeafId: LEAF, layout: null }],
    leaves: [
      {
        tabId: 'tab-1',
        worktreeId: WT,
        leafId: LEAF,
        paneRuntimeId: 1,
        ptyId: 'pty-1',
        paneTitle: null
      }
    ]
  }
}

it('wakes no mounted crew for the runtime’s own graph publishes and hook status rows of other panes', async () => {
  const runtime = new OrcaRuntimeService(partialRuntimeStore({ getSettings: () => ({}) }))
  const server = new AgentHookServer()
  runtime.attachAgentStatusStore(server)
  await runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, graph('Agent'))
  const party = 'term_unrelated_coordinator'
  let reads = 0
  const frames: OrchestrationCrewFrame[] = []
  const stop = subscribeCrew(
    () => {
      reads++
      return runtime.getOrchestrationCrewSnapshot(party)
    },
    runtime.watchOrchestrationCrew(party),
    (frame) => frames.push(frame)
  )
  try {
    await flush()
    reads = 0
    frames.length = 0
    for (let index = 0; index < 20; index++) {
      // Through terminal-view-resources: graph publishes and title changes write terminal records.
      await runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, graph(`Agent ${index}`))
      // Through orca-runtime-agent-transitions: a hook status row for a pane no crew shows.
      server.ingestTerminalStatus({
        paneKey: `tab-1:${LEAF}`,
        tabId: 'tab-1',
        worktreeId: WT,
        payload: { state: index % 2 ? 'working' : 'done', prompt: 'task', agentType: 'claude' }
      })
    }
    await flush()
    expect({ reads, frames: frames.length }).toEqual({ reads: 0, frames: 0 })
  } finally {
    stop()
  }
})

it('wakes only the crew stream whose party a Dispatch write concerns, through the runtime’s subscribe', async () => {
  const runtime = new OrcaRuntimeService(partialRuntimeStore({ getSettings: () => ({}) }))
  const db = new OrchestrationDb(':memory:')
  runtime.setOrchestrationDb(db)
  // Two coordinators, each with its own worker: crews that share no party.
  const tasks = [0, 1].map((index) => {
    const coordinator = `term_c${index}`
    const run = db.createRun({
      objective: `Crew ${index}`,
      coordinatorHandle: coordinator,
      coordinatorPaneKey: null
    })
    const task = db.createTask({ runId: run.id, spec: `Task ${index}` })
    db.createDispatchContext({
      taskId: task.id,
      assigneeHandle: `term_b${index}`,
      creator: { kind: 'terminal', handle: coordinator },
      maxDepth: 10
    })
    return task.id
  })
  const reads = new Map<string, number>()
  const stops = ['term_c0', 'term_c1'].map((party) =>
    subscribeCrew(
      () => {
        reads.set(party, (reads.get(party) ?? 0) + 1)
        return runtime.getOrchestrationCrewSnapshot(party)
      },
      runtime.watchOrchestrationCrew(party),
      () => {}
    )
  )
  try {
    await flush()
    reads.clear()
    db.updateTaskStatus(tasks[0]!, 'completed', 'done')
    await flush()
    expect(Object.fromEntries(reads)).toEqual({ term_c0: 1 })
  } finally {
    stops.forEach((stop) => stop())
    db.close()
  }
})
