import { beforeEach, describe, expect, it, vi } from 'vitest'

const callMock = vi.fn()

vi.mock('../../format', () => ({ printResult: vi.fn() }))
vi.mock('../../selectors', () => ({ getTerminalHandle: vi.fn() }))

import { ORCHESTRATION_HANDLERS } from '../orchestration'
import { printResult } from '../../format'

describe('orchestration worker-list display state', () => {
  beforeEach(() => {
    callMock.mockReset()
    vi.mocked(printResult).mockReset()
  })

  it('prints a failed main-agent turn instead of the folded activity', async () => {
    const row = (dispatchId: string, stage: Record<string, unknown>) => ({
      dispatchId,
      taskId: `task_${dispatchId}`,
      runId: 'run_1',
      workerState: 'running',
      dispatchStatus: 'dispatched',
      agentTerminalHandle: `term_${dispatchId}`,
      terminalState: 'active',
      resource: null,
      projection: {
        provider: null,
        host: { id: 'local' },
        workspace: null,
        stage,
        liveness: { verdict: 'live' },
        nextAction: { argv: [] },
        attention: { categories: [] }
      }
    })
    const response = {
      result: {
        workers: [
          row('failed', {
            activity: 'working',
            mainAgent: { state: 'done', outcome: 'failure', stateStartedAt: 1 }
          }),
          row('legacy', { activity: 'working' }),
          row('stale', {
            activity: 'unknown',
            mainAgent: { state: 'done', outcome: 'failure', stateStartedAt: 1 }
          })
        ],
        counts: {},
        page: { total: 3, hasMore: false, nextCursor: null }
      }
    }
    callMock.mockResolvedValue(response)

    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: `worker-list` reads only `flags`, `client.call` and `json`; RuntimeClient is a class a structural double cannot satisfy.
    await ORCHESTRATION_HANDLERS['orchestration worker-list']({
      flags: new Map<string, string | boolean>(),
      client: { call: callMock },
      cwd: '/tmp/repo',
      json: false
    } as never)

    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler passes its text formatter as printResult's third argument.
    const formatter = vi.mocked(printResult).mock.calls[0]?.[2] as
      | ((result: (typeof response)['result']) => string)
      | undefined
    const output = formatter?.(response.result) ?? ''
    expect(output).toContain('failed task=task_failed [running/failed] attention=none')
    expect(output).toContain('legacy task=task_legacy [running/working] attention=none')
    expect(output).toContain('stale task=task_stale [running/unknown] attention=none')
  })
})
