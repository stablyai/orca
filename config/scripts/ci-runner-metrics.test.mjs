import { expect, it } from 'vitest'
import { runnerDemand, sampleWorkflowRuns } from './ci-runner-metrics.mjs'
import { collectRunnerDemand } from './ci-runner-demand.mjs'

const run = {
  id: 1,
  path: '.github/workflows/pr.yml',
  event: 'pull_request',
  conclusion: 'success'
}
const job = {
  runner_name: 'hosted',
  labels: ['ubuntu-latest'],
  created_at: '2026-09-27T00:00:00Z',
  started_at: '2026-09-27T00:03:00Z',
  completed_at: '2026-09-27T00:08:00Z'
}

it('separates occupancy, queueing, cancellations and zero-job observations', () => {
  const cancelled = { ...run, id: 2, conclusion: 'cancelled' }
  const report = runnerDemand(
    [run, cancelled],
    [
      { run, weight: 2, jobs: [job, { ...job, runner_name: null }] },
      { run: cancelled, weight: 3, jobs: [job, { ...job, completed_at: null }] }
    ]
  )
  expect(report.workflows[0]).toMatchObject({
    runnerMinutes: 25,
    cancelledRunnerMinutes: 15,
    runnerMinutesPerCompletedPrRun: 5
  })
  expect(report.pools[0].queueP95Minutes).toBe(3)
  expect(report.incompleteJobs).toBe(1)
  expect(runnerDemand([run], [{ run, weight: 1, jobs: [] }]).workflows[0].runnerMinutes).toBe(0)
})

it('weights each workflow/outcome stratum back to the full inventory', () => {
  const runs = Array.from({ length: 20 }, (_, index) => ({
    ...run,
    id: index,
    conclusion: index < 10 ? 'success' : 'failure'
  }))
  const sample = sampleWorkflowRuns(runs, 2, () => 0.5)
  expect(sample).toHaveLength(4)
  expect(sample.reduce((sum, row) => sum + row.weight, 0)).toBe(20)
  expect(new Set(sample.map((row) => row.run.id)).size).toBe(4)
})

it('paginates jobs and bounds run discovery to 24 complete hours', async () => {
  const requests = []
  const result = await collectRunnerDemand(
    { CI_METRICS_END: '2026-09-28T04:59:00Z' },
    async (path) => {
      requests.push(path)
      if (path.includes('/jobs')) {
        return {
          total_count: 101,
          jobs: path.includes('page=2') ? [job] : Array.from({ length: 100 }, () => job)
        }
      }
      return {
        total_count: requests.length === 1 ? 1 : 0,
        workflow_runs: requests.length === 1 ? [run] : []
      }
    }
  )
  expect(result.report.start).toBe('2026-09-27T04:00:00.000Z')
  expect(result.report.end).toBe('2026-09-28T04:00:00.000Z')
  expect(requests.filter((path) => path.startsWith('actions/runs?'))).toHaveLength(24)
  expect(result.samples[0].jobs).toHaveLength(101)
  expect(result.report.workflows[0].runnerMinutes).toBe(505)
})

it('refuses to publish a silently truncated inventory', async () => {
  await expect(
    collectRunnerDemand({}, async () => ({ total_count: 1001, workflow_runs: [] }))
  ).rejects.toThrow('API limit')
})

it('groups ref-qualified paths under the stable workflow ID', () => {
  const runs = [
    { ...run, id: 1, workflow_id: 42, path: '.github/workflows/pr.yml@main' },
    { ...run, id: 2, workflow_id: 42, path: '.github/workflows/pr.yml@feature' }
  ]
  const sample = sampleWorkflowRuns(runs, 1, () => 0.5)
  expect(sample).toHaveLength(1)
  expect(sample[0].weight).toBe(2)
  expect(
    runnerDemand(
      runs,
      sample.map((row) => ({ ...row, jobs: [job] }))
    ).workflows
  ).toMatchObject([{ workflow: '.github/workflows/pr.yml', runs: 2, runnerMinutes: 10 }])
})
