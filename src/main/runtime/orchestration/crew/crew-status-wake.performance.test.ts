// Perf contract for STA-16417: a shown worker's status wake rereads that worker's row, not every row on the host.
import { expect, it } from 'vitest'
import type { FleetAgentStatusEvidence } from '../../../../shared/orchestration/fleet/orchestration-fleet-agent-status-evidence'
import type { AgentStatusState } from '../../../../shared/agent-status/contracts/agent-status-types'
import { CrewReadModel } from './crew-read-model'
import { crewStatusRowChange } from './crew-changes'
import { fixture } from './crew-read-model.test-fixture'

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

function statusWakeCost(hostRows: number) {
  const f = fixture()
  const worker = f.assign('term_worker')
  const workerPane = f.handles.get('term_worker')!
  const rows = new Map<string, FleetAgentStatusEvidence>([
    [workerPane, status('term_worker', workerPane, 'working', worker.id)]
  ])
  for (let index = 0; index < hostRows; index++) {
    const pane = `tab_other${index}:pane`
    rows.set(pane, status(`term_other${index}`, pane, 'working'))
  }
  const reads = { everyRow: 0, rows: 0 }
  const model = new CrewReadModel(
    () => ({
      ...f.deps,
      get statuses() {
        reads.everyRow++
        return [...rows.values()]
      },
      statusesForPanes: (panes) => {
        const read = [...panes].flatMap((pane) => rows.get(pane) ?? [])
        reads.rows += read.length
        return read
      }
    }),
    (wake) => f.db.crewChanges.subscribe(wake)
  )
  const stop = model.subscribe(() => {}, 'term_coord')
  try {
    model.read('term_coord')
    reads.everyRow = reads.rows = 0
    rows.set(workerPane, status('term_worker', workerPane, 'waiting', worker.id))
    f.db.crewChanges.notify(
      crewStatusRowChange({ before: { paneKey: workerPane }, after: { paneKey: workerPane } })
    )
    const shown = model.read('term_coord').sections.managing.map((row) => row.status)
    return { ...reads, shown }
  } finally {
    stop()
  }
}

it('rereads only the changed worker row on a status wake, at N and 10N host status rows', () => {
  const expected = { everyRow: 0, rows: 1, shown: ['waiting'] }
  expect(statusWakeCost(100)).toEqual(expected)
  expect(statusWakeCost(1000)).toEqual(expected)
})
