/** Only a start that launched an agent reaches the started-worker hook: a bot holds its thread on that worker. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as WorkerStartCard from '../../../../orchestration/workers/launch/worker-start-card'
import { createOrchestrationWorkerReleaseHarness } from './testing/worker-release.test-support'

const recordedStarts = vi.hoisted((): boolean[] => [])
vi.mock('../../../../orchestration/workers/launch/worker-start-card', async (importOriginal) => {
  const actual = await importOriginal<typeof WorkerStartCard>()
  return {
    ...actual,
    prepareWorkerStartCard: (...args: Parameters<typeof actual.prepareWorkerStartCard>) => {
      const record = actual.prepareWorkerStartCard(...args)
      return (started: Parameters<typeof record>[0]) => {
        recordedStarts.push(started.ready)
        record(started)
      }
    }
  }
})

describe('the started-worker hook on a local start', () => {
  const h = createOrchestrationWorkerReleaseHarness()

  afterEach(() => {
    recordedStarts.length = 0
    h.cleanup()
  })

  async function start(): Promise<unknown> {
    const task = h.db.createTask({ spec: 'recorded start', runId: h.activeRunId })
    return await h.call('orchestration.workerStart', {
      task: task.id,
      from: 'term_coord',
      agent: 'codex'
    })
  }

  const unknown = (): Error =>
    Object.assign(new Error('the execution host went away'), { code: 'operation_unknown' })

  it('records a ready start, and an unknown one whose agent launched', async () => {
    h.setup()
    await expect(start()).resolves.toMatchObject({ state: 'ready' })
    vi.spyOn(h.runtime, 'waitForTerminal').mockRejectedValue(unknown())
    await expect(start()).resolves.toMatchObject({ state: 'outcome_unknown' })
    expect(recordedStarts).toEqual([true, false])
  })

  it('records nothing for an unknown start that never got a terminal', async () => {
    h.setup()
    vi.spyOn(h.runtime, 'createTerminal').mockRejectedValue(unknown())
    await expect(start()).resolves.toMatchObject({ state: 'outcome_unknown' })
    expect(recordedStarts).toEqual([])
  })
})
