import { describe, expect, it, vi } from 'vitest'
import { HermesRunHistory, type HermesRunHistorySources } from './hermes-run-history'
import type { HermesOutputRunRef } from './hermes-run-correlation'

function outputRef(day: number, jobId = 'job-1'): HermesOutputRunRef {
  const dayText = String(day).padStart(2, '0')
  return {
    kind: 'output',
    id: `${jobId}:2026-05-${dayText}_09-00-00.md`,
    job_id: jobId,
    run_at: `2026-05-${dayText}T09:00:00`,
    run_key: `202605${dayText}_090000`,
    output_path: `/output/${jobId}/${dayText}.md`
  }
}

function sources(overrides: Partial<HermesRunHistorySources> = {}): HermesRunHistorySources {
  return {
    readOutputRefs: async () => [],
    readSessionRefs: () => [],
    readOutputRun: async (ref) => ref,
    readSessionRun: () => null,
    ...overrides
  }
}

describe('HermesRunHistory', () => {
  it('paginates refs before hydrating run content', async () => {
    const readOutputRun = vi.fn(async (ref: HermesOutputRunRef) => ref)
    const history = new HermesRunHistory(
      sources({
        readOutputRefs: async () => [outputRef(16), outputRef(15), outputRef(14)],
        readOutputRun
      })
    )

    const result = await history.listRuns({
      provider: 'hermes',
      jobId: 'job-1',
      page: 1,
      pageSize: 2
    })

    expect(result.total).toBe(3)
    expect(result.runs).toEqual([outputRef(16), outputRef(15)])
    expect(readOutputRun).toHaveBeenCalledTimes(2)
  })

  it('uses a count-only path without hydrating content', async () => {
    const readOutputRun = vi.fn()
    const history = new HermesRunHistory(
      sources({ readOutputRefs: async () => [outputRef(16), outputRef(15)], readOutputRun })
    )

    await expect(
      history.listRuns({ provider: 'hermes', jobId: 'job-1', pageSize: 0 })
    ).resolves.toEqual({ total: 2, runs: [] })
    expect(readOutputRun).not.toHaveBeenCalled()
  })

  it('deduplicates concurrent count reads', async () => {
    let resolveRefs: (refs: HermesOutputRunRef[]) => void = () => {}
    const readOutputRefs = vi.fn(
      () =>
        new Promise<HermesOutputRunRef[]>((resolve) => {
          resolveRefs = resolve
        })
    )
    const history = new HermesRunHistory(sources({ readOutputRefs }))

    const first = history.listRuns({ provider: 'hermes', jobId: 'job-1', pageSize: 0 })
    const second = history.listRuns({ provider: 'hermes', jobId: 'job-1', pageSize: 0 })
    expect(readOutputRefs).toHaveBeenCalledTimes(1)
    resolveRefs([outputRef(16), outputRef(15)])

    await expect(Promise.all([first, second])).resolves.toEqual([
      { total: 2, runs: [] },
      { total: 2, runs: [] }
    ])
  })

  it('evicts a failed count read so the next call retries', async () => {
    const readError = new Error('output directory unavailable')
    const readOutputRefs = vi
      .fn<() => Promise<HermesOutputRunRef[]>>()
      .mockRejectedValueOnce(readError)
      .mockResolvedValueOnce([outputRef(16)])
    const history = new HermesRunHistory(sources({ readOutputRefs }))

    await expect(
      history.listRuns({ provider: 'hermes', jobId: 'job-1', pageSize: 0 })
    ).rejects.toBe(readError)
    await expect(
      history.listRuns({ provider: 'hermes', jobId: 'job-1', pageSize: 0 })
    ).resolves.toEqual({ total: 1, runs: [] })
    expect(readOutputRefs).toHaveBeenCalledTimes(2)
  })

  it('clears a cached count for one lifecycle-mutated job', async () => {
    const readOutputRefs = vi
      .fn<() => Promise<HermesOutputRunRef[]>>()
      .mockResolvedValueOnce([outputRef(15)])
      .mockResolvedValueOnce([outputRef(16), outputRef(15)])
    const history = new HermesRunHistory(sources({ readOutputRefs }))

    await history.listRuns({ provider: 'hermes', jobId: 'job-1', pageSize: 0 })
    await history.listRuns({ provider: 'hermes', jobId: 'job-1', pageSize: 0 })
    history.clearRunCount('job-1')

    await expect(
      history.listRuns({ provider: 'hermes', jobId: 'job-1', pageSize: 0 })
    ).resolves.toEqual({ total: 2, runs: [] })
    expect(readOutputRefs).toHaveBeenCalledTimes(2)
  })

  it('returns empty OpenClaw history before validating its job ID', async () => {
    const history = new HermesRunHistory(sources())

    await expect(
      history.listRuns({ provider: 'openclaw', jobId: '--invalid', pageSize: 25 })
    ).resolves.toEqual({ total: 0, runs: [] })
  })

  it('evicts the oldest cached job at the 200-entry bound', async () => {
    const readOutputRefs = vi.fn(async (jobId: string) =>
      jobId === 'job-0' ? [outputRef(15, jobId)] : []
    )
    const history = new HermesRunHistory(sources({ readOutputRefs }))

    await history.listRuns({ provider: 'hermes', jobId: 'job-0', pageSize: 0 })
    for (let index = 1; index <= 200; index += 1) {
      await history.listRuns({ provider: 'hermes', jobId: `job-${index}`, pageSize: 0 })
    }
    await history.listRuns({ provider: 'hermes', jobId: 'job-0', pageSize: 0 })

    expect(readOutputRefs).toHaveBeenCalledTimes(202)
  })
})
