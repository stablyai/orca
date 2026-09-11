import { expect, it, vi } from 'vitest'
import { mapHermesJobs, mapOpenClawJobs } from './external-job-mappers'

it.each([mapHermesJobs, mapOpenClawJobs])(
  'parses run dates once and preserves provider fallback ordering',
  (mapJobs) => {
    const runs = Array.from({ length: 2000 }, (_, i) => ({
      id: String(i),
      run_at:
        i % 137 === 0
          ? 'invalid'
          : new Date(1700000000000 + ((i * 173) % 1999) * 1000).toISOString(),
      output_content: `Output ${i}`,
      status: 'completed'
    }))
    const parse = vi.spyOn(Date, 'parse')
    let expected: typeof runs
    let jobs: ReturnType<typeof mapHermesJobs>
    try {
      expected = [...runs].sort((a, b) => {
        const left = Date.parse(a.run_at),
          right = Date.parse(b.run_at)
        return Number.isFinite(left) && Number.isFinite(right)
          ? right - left
          : b.id.localeCompare(a.id)
      })
      expect(parse.mock.calls.length).toBeGreaterThan(10_000)
      parse.mockClear()
      jobs = mapJobs('manager', [{ id: 'job', runs }])
      expect(parse).toHaveBeenCalledTimes(2000)
    } finally {
      parse.mockRestore()
    }
    expect(jobs[0].runs.map((run) => run.id)).toEqual(expected.map((run) => run.id))
    expect(jobs[0].runs.every((run) => run.outputContent === `Output ${run.id}`)).toBe(true)
    expect(jobs[0].runs.every((run) => !('time' in run))).toBe(true)
  }
)
