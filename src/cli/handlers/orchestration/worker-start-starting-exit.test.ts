import { afterEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_HANDLERS } from '../orchestration'

/** A start the host is still settling is not a failure: only a settled non-ready start exits 1. */
describe('worker-start exit status', () => {
  afterEach(() => {
    process.exitCode = undefined
    vi.restoreAllMocks()
  })

  it.each([
    ['starting', undefined],
    ['ready', undefined],
    ['outcome_unknown', 1],
    ['failed', 1]
  ])('exits %s -> %s', async (state, exitCode) => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const client = {
      call: async () => ({
        result: {
          runId: 'run_1',
          taskId: 'task_1',
          dispatchId: 'ctx_1',
          state,
          effects: [],
          residualResources: []
        }
      })
    }

    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler reads only these context fields.
    await ORCHESTRATION_HANDLERS['orchestration worker-start']({
      flags: new Map([
        ['task', 'task_1'],
        ['from', 'term_coord']
      ]),
      client,
      cwd: '/tmp/repo',
      json: true
    } as never)

    expect(process.exitCode).toBe(exitCode)
  })
})
