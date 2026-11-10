import { describe, expect, it } from 'vitest'
import { WORKER_LIST_VIEW, WORKER_SHOW_VIEW } from './worker-agent-views'

describe('worker views of a worker a paired server runs', () => {
  it('labels an offline show with its server, record time, last report and note', () => {
    expect(
      WORKER_SHOW_VIEW.fields({
        dispatch: { id: 'ctx_w1', taskId: 'task_1', runId: 'run_1', status: 'dispatched' },
        worker: {
          dispatchId: 'ctx_w1',
          state: 'ready',
          stage: 'server_unreachable',
          agentTerminalHandle: null
        },
        projection: null,
        observation: { reason: 'devB could not be reached, so this is this Orca’s record.' },
        server: { name: 'devB', asOf: '2026-11-09T08:30:00Z', reachable: false },
        lastReport: 'Halfway: tests written.'
      })
    ).toMatchObject({
      dispatchId: 'ctx_w1',
      state: 'ready',
      stage: 'server_unreachable',
      server: 'devB',
      asOf: '2026-11-09T08:30:00Z',
      lastReport: 'Halfway: tests written.',
      note: 'devB could not be reached, so this is this Orca’s record.',
      waitingOnHuman: 'unknown'
    })
  })

  it('names a listed remote worker’s server, and says when its pairing was re-made', () => {
    const row = {
      taskId: 'task_1',
      runId: 'run_1',
      workerState: 'ready',
      dispatchStatus: 'dispatched',
      agentTerminalHandle: null,
      terminalState: null
    }
    const fields = WORKER_LIST_VIEW.fields({
      workers: [
        { ...row, dispatchId: 'ctx_w1', server: { name: 'devB', asOf: '2026-11-09T08:30:00Z' } },
        {
          ...row,
          dispatchId: 'ctx_w2',
          server: { name: 'devB', asOf: '2026-11-09T08:45:00Z', repaired: true }
        }
      ],
      counts: {},
      scope: { source: 'all' }
    })
    expect(fields.workers).toEqual([
      expect.objectContaining({ dispatchId: 'ctx_w1', host: 'devB', asOf: '2026-11-09T08:30:00Z' }),
      expect.objectContaining({ dispatchId: 'ctx_w2', host: 'devB (pairing re-made)' })
    ])
  })
})
