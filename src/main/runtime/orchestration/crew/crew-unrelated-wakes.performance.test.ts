import { expect, it } from 'vitest'
import type { FleetAgentStatusEvidence } from '../../../../shared/orchestration/fleet/orchestration-fleet-agent-status-evidence'
import type { AgentStatusState } from '../../../../shared/agent-status/contracts/agent-status-types'
import type { RuntimeClientEvent } from '../../../../shared/remote-runtime/session-graph/runtime-client-events'
import type { OrchestrationCrewFrame } from '../../../../shared/orchestration/orchestration-crew'
import { CrewReadModel } from './crew-read-model'
import { subscribeCrew } from './crew-stream'
import { watchCrewRuntimeSources } from './crew-runtime-watch'
import { fixture } from './crew-read-model.test-fixture'
import { crewStatusRowChange } from './crew-changes'
import { createCrewNotifiedTerminalIdentity } from '../../terminal/identity/terminal-identity-crew-notice'

const flush = async () => {
  for (let i = 0; i < 4; i++) {
    await Promise.resolve()
  }
}

function status(
  handle: string,
  paneKey: string,
  state: AgentStatusState,
  dispatchId?: string
): FleetAgentStatusEvidence {
  const terminal = { terminalHandle: handle, paneKey, processIncarnation: `process:${handle}` }
  // ast-grep-ignore: test-no-wall-clock -- evidence must be fresh by the read model's own clock
  const now = Date.now()
  return {
    binding: dispatchId
      ? { kind: 'worker', dispatchId, ...terminal }
      : { kind: 'pane', ...terminal },
    clock: { kind: 'observed', at: now },
    deliveredAt: now,
    activity: {
      paneKey,
      connectionId: null,
      state,
      agentType: 'claude',
      model: null,
      worktreeId: null,
      restoredUnconfirmed: false,
      providerSessionOnly: false
    }
  }
}

/** A mounted crew among 100 unrelated agents and another workspace's federated worker. */
function mountedCrew() {
  const f = fixture()
  const worker = f.assign('term_worker')
  const elsewhere = f.db.createRun({
    objective: 'Elsewhere',
    coordinatorHandle: 'term_far',
    coordinatorPaneKey: 'tab_far:pane'
  })
  const far = f.db.createStartingWorkerDispatch({
    taskSpec: 'Far away',
    taskRunId: elsewhere.id,
    startOptions: {},
    runtimeEpoch: 'epoch',
    creator: { kind: 'system' },
    maxDepth: 10,
    federation: {
      environmentId: 'environment-far',
      environmentName: 'far',
      peerFingerprint: 'peer-far',
      protocolVersion: 3
    }
  })
  const unrelated = Array.from({ length: 100 }, (_, index) =>
    status(`term_other${index}`, `tab_other${index}:pane`, 'working')
  )
  const workerPane = f.handles.get('term_worker')!
  let statuses = [status('term_worker', workerPane, 'working', worker.id), ...unrelated]
  const counts = { sql: 0, statusReads: 0, frames: 0 }
  const prepare = f.db.db.prepare.bind(f.db.db)
  f.db.db.prepare = (sql: string) => {
    counts.sql++
    return prepare(sql)
  }
  let transition: (change: { paneKey: string }) => void = () => {}
  let client: (event: RuntimeClientEvent) => void = () => {}
  const model = new CrewReadModel(
    () => ({
      ...f.deps,
      get statuses() {
        counts.statusReads++
        return statuses
      }
    }),
    (wake, relevance) =>
      watchCrewRuntimeSources(
        {
          store: null,
          watchChanges: f.db.crewChanges.subscribe,
          watchTransitions: (listener) => {
            transition = listener
            return () => {}
          },
          watchClient: (listener) => {
            client = listener
            return () => {}
          }
        },
        wake,
        relevance
      )
  )
  const frames: OrchestrationCrewFrame[] = []
  const stop = subscribeCrew(
    () => model.read('term_coord'),
    model.subscribe,
    (frame) => frames.push(frame)
  )
  return {
    f,
    worker,
    far,
    workerPane,
    counts,
    frames,
    stop,
    transition: (paneKey: string) => transition({ paneKey }),
    title: (paneKey: string) =>
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the watch reads only type, paneKey and fact kinds.
      client({
        type: 'terminalSideEffects',
        batch: { paneKey, facts: [{ kind: 'title' }] }
      } as unknown as RuntimeClientEvent),
    setWorkerState: (state: AgentStatusState) => {
      statuses = [status('term_worker', workerPane, state, worker.id), ...unrelated]
    },
    /** A hook status row for a pane no crew shows appears, then leaves. */
    statusRow: (paneKey: string) => {
      statuses = [...statuses, status(`term_${paneKey}`, paneKey, 'working')]
      f.db.crewChanges.notify(crewStatusRowChange({ before: null, after: { paneKey } }))
      statuses = statuses.filter((row) => row.activity.paneKey !== paneKey)
      f.db.crewChanges.notify(crewStatusRowChange({ before: { paneKey }, after: null }))
    },

    reset: () => {
      counts.sql = 0
      counts.statusReads = 0
      frames.length = 0
    }
  }
}

it('reads nothing and sends nothing for unrelated status, title, status-row, terminal-record, run and federation writes', async () => {
  const crew = mountedCrew()
  try {
    await flush()
    expect(crew.frames.some((frame) => frame.type === 'complete')).toBe(true)
    crew.reset()
    for (let index = 0; index < 50; index++) {
      crew.transition(`tab_other${index}:pane`)
      crew.title(`tab_other${index}:pane`)
    }
    await flush()
    expect(crew.counts).toEqual({ sql: 0, statusReads: 0, frames: 0 })

    // Writes to another workspace's federated worker run their own SQL; the crew adds none.
    crew.f.db.reconcileFederatedWorkerStart({
      dispatchId: crew.far.dispatch.id,
      state: 'ready',
      stage: 'remote_input_accepted',
      worktreeId: 'repo::far',
      terminalHandle: 'term_far_worker'
    })
    crew.f.db.recordWorkerStage({ dispatchId: crew.far.dispatch.id, stage: 'remote_running' })
    crew.reset()
    await flush()
    expect(crew.counts).toEqual({ sql: 0, statusReads: 0, frames: 0 })

    // Hook status rows for unrelated panes, added and removed: no read, no rebuild.
    for (let index = 0; index < 50; index++) {
      crew.statusRow(`tab_row${index}:pane`)
    }
    await flush()
    expect(crew.counts).toEqual({ sql: 0, statusReads: 0, frames: 0 })

    // Another workspace's run: a new Run, Task, Dispatch and Task status write.
    const foreign = crew.f.db.createRun({
      objective: 'Foreign',
      coordinatorHandle: 'term_foreign',
      coordinatorPaneKey: 'tab_foreign:pane'
    })
    const task = crew.f.db.createTask({ spec: 'Foreign task', runId: foreign.id })
    crew.f.db.createDispatchContext({
      taskId: task.id,
      assigneeHandle: 'term_foreign_worker',
      creator: { kind: 'terminal', handle: 'term_foreign', paneKey: 'tab_foreign:pane' },
      maxDepth: 10
    })
    crew.f.db.updateTaskStatus(task.id, 'completed', 'done')
    crew.reset()
    await flush()
    expect(crew.counts).toEqual({ sql: 0, statusReads: 0, frames: 0 })

    // Renderer graph publishes and layout syncs rewrite terminal records no crew row resolves through.
    const records = createCrewNotifiedTerminalIdentity(crew.f.db.crewChanges)
    for (let index = 0; index < 50; index++) {
      records.advanceGraphSequence()
      records.replaceLeaves(new Map())
      records.addSynthetic(`term_synthetic${index}`)
    }
    await flush()
    expect(crew.counts).toEqual({ sql: 0, statusReads: 0, frames: 0 })

    // Control: the crew worker's own status change still reaches its row.
    crew.setWorkerState('waiting')
    crew.transition(crew.workerPane)
    await flush()
    expect(crew.counts.sql).toBe(0)
    expect(crew.frames.filter((frame) => frame.type === 'complete')).toHaveLength(1)
  } finally {
    crew.stop()
  }
})

it('rereads only the crew a worker event concerns, however many crews are mounted', async () => {
  const f = fixture()
  // Four coordinators, each with its own worker: crews that share no party.
  const crews = [0, 1, 2, 3].map((index) => {
    const coordinator = `term_c${index}`
    const worker = `term_b${index}`
    f.handles.set(coordinator, `tab_c${index}:aaaaaaaa-aaaa-4aaa-8aaa-c${index}aaaaaaaaaa`)
    f.handles.set(worker, `tab_b${index}:aaaaaaaa-aaaa-4aaa-8aaa-b${index}aaaaaaaaaa`)
    const run = f.db.createRun({
      objective: `Crew ${index}`,
      coordinatorHandle: coordinator,
      coordinatorPaneKey: f.handles.get(coordinator)!
    })
    const task = f.db.createTask({ runId: run.id, spec: `Task ${index}` })
    const dispatch = f.db.createDispatchContext({
      taskId: task.id,
      assigneeHandle: worker,
      assigneePaneKey: f.handles.get(worker),
      creator: { kind: 'terminal', handle: coordinator, paneKey: f.handles.get(coordinator) },
      maxDepth: 10
    })
    return { coordinator, workerPane: f.handles.get(worker)!, worker, dispatch }
  })
  let states: AgentStatusState[] = ['working', 'working', 'working', 'working']
  const statuses = () =>
    crews.map((crew, index) =>
      status(crew.worker, crew.workerPane, states[index]!, crew.dispatch.id)
    )
  let transition: (change: { paneKey: string }) => void = () => {}
  const model = new CrewReadModel(
    () => ({ ...f.deps, statuses: statuses() }),
    (wake, relevance) =>
      watchCrewRuntimeSources(
        {
          store: null,
          watchChanges: f.db.crewChanges.subscribe,
          watchTransitions: (listener) => {
            transition = listener
            return () => {}
          },
          watchClient: () => () => {}
        },
        wake,
        relevance
      )
  )
  const reads = new Map<string, number>()
  const frames = new Map<string, number>()
  const stops = crews.map(({ coordinator }) =>
    subscribeCrew(
      () => {
        reads.set(coordinator, (reads.get(coordinator) ?? 0) + 1)
        return model.read(coordinator)
      },
      (wake) => model.subscribe(wake, coordinator),
      (frame) => {
        if (frame.type === 'complete') {
          frames.set(coordinator, (frames.get(coordinator) ?? 0) + 1)
        }
      }
    )
  )
  try {
    await flush()
    reads.clear()
    frames.clear()
    states = ['waiting', 'working', 'working', 'working']
    transition({ paneKey: crews[0]!.workerPane })
    await flush()
    expect(Object.fromEntries(reads)).toEqual({ term_c0: 1 })
    expect(Object.fromEntries(frames)).toEqual({ term_c0: 1 })
  } finally {
    stops.forEach((stop) => stop())
  }
})
