import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPluginSourceTranspileClient } from './plugin-source-transpile-client'
import type {
  PluginSourceTranspiled,
  PluginSourceTranspileRequest,
  PluginSourceTranspileResponse
} from './source-transpilation/plugin-source-transpile-protocol'
import { inProcessWorker } from '../../worker-threads/in-process-worker.test-fixture'

const BUDGET_MS = 100
const TRANSPILED: PluginSourceTranspiled = { ok: true, code: 'x', mappings: '', imports: [] }

function setup(answerAfterMs = 0) {
  const worker = inProcessWorker(async (request: PluginSourceTranspileRequest) => {
    // ast-grep-ignore: test-no-real-time-wait -- every test here runs on fake timers
    await new Promise((resolve) => setTimeout(resolve, answerAfterMs))
    const response: PluginSourceTranspileResponse = { id: request.id, result: TRANSPILED }
    return response
  })
  const transpile = createPluginSourceTranspileClient({
    createWorker: worker.factory,
    budgetMs: BUDGET_MS
  })
  return { transpile, controls: worker.controls }
}

describe('createPluginSourceTranspileClient', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('does not count a worker cold start against the budget', async () => {
    const { transpile } = setup(BUDGET_MS * 5)

    const pending = transpile('main.ts', 'export {}')
    await vi.advanceTimersByTimeAsync(BUDGET_MS * 5)
    expect(await pending).toEqual(TRANSPILED)
  })

  it('replaces a worker that never reports ready after the boot budget', async () => {
    const { transpile, controls } = setup()
    controls.hangsOn = () => true

    const stalled = transpile('main.ts', 'export {}')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await stalled).toEqual({
      ok: false,
      message: 'the transpiler did not start within 10000 ms',
      transient: true
    })

    controls.hangsOn = () => false
    const retried = transpile('main.ts', 'export {}')
    await vi.advanceTimersByTimeAsync(BUDGET_MS)
    expect(await retried).toEqual(TRANSPILED)
    expect(controls.spawned).toBe(2)
  })
})
