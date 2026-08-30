import { beforeEach, describe, expect, it, vi } from 'vitest'

const callMock = vi.fn()

vi.mock('../format', () => ({ printResult: vi.fn() }))
vi.mock('../selectors', () => ({ getTerminalHandle: vi.fn() }))

import { ORCHESTRATION_HANDLERS } from './orchestration'

describe('orchestration capacity CLI contract', () => {
  beforeEach(() => callMock.mockReset())

  it('forwards target configuration with mutation replay identity', async () => {
    callMock.mockResolvedValue({ result: { capacity: { runId: 'run_1' } } })

    await ORCHESTRATION_HANDLERS['orchestration capacity-set']({
      flags: new Map<string, string | boolean>([
        ['target', '5'],
        ['run', 'run_1'],
        ['from', 'term_coord'],
        ['retry-request', 'request_1']
      ]),
      client: { call: callMock },
      cwd: '/tmp/repo',
      json: true
    } as never)

    expect(callMock).toHaveBeenCalledWith(
      'orchestration.capacityConfigure',
      { target: 5, run: 'run_1', from: 'term_coord' },
      { orchestrationRequestId: 'request_1' }
    )
  })

  it('marks a worker start as an enrolled capacity claim only when requested', async () => {
    callMock
      .mockResolvedValueOnce({
        result: { capabilities: ['orchestration.run-capacity.v1'] }
      })
      .mockResolvedValueOnce({
        result: {
          runId: 'run_1',
          taskId: 'task_1',
          dispatchId: 'ctx_1',
          state: 'ready',
          effects: [],
          residualResources: []
        }
      })

    await ORCHESTRATION_HANDLERS['orchestration worker-start']({
      flags: new Map<string, string | boolean>([
        ['task', 'task_1'],
        ['agent', 'codex'],
        ['capacity-slot', true],
        ['from', 'term_coord']
      ]),
      client: { call: callMock },
      cwd: '/tmp/repo',
      json: true
    } as never)

    expect(callMock).toHaveBeenNthCalledWith(
      2,
      'orchestration.workerStart',
      expect.objectContaining({ task: 'task_1', capacitySlot: true })
    )
  })
})
