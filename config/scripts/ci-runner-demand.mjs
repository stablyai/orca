import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { runnerDemand, sampleWorkflowRuns } from './ci-runner-metrics.mjs'

async function api(path, env) {
  const response = await fetch(
    `${env.GITHUB_API_URL ?? 'https://api.github.com'}/repos/${env.GITHUB_REPOSITORY}/${path}`,
    {
      headers: {
        Authorization: `Bearer ${env.GH_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28'
      },
      signal: AbortSignal.timeout(30_000)
    }
  )
  if (!response.ok) {
    throw new Error(`Actions API: ${response.status}`)
  }
  return response.json()
}

export async function collectRunnerDemand(env = process.env, request = (path) => api(path, env)) {
  const end = new Date(env.CI_METRICS_END ?? Date.now())
  end.setUTCMinutes(0, 0, 0)
  if (!Number.isFinite(end.getTime())) {
    throw new Error('Invalid window end')
  }
  const runs = []
  for (let hour = 0; hour < 24; hour++) {
    const until = new Date(end.getTime() - hour * 3_600_000 - 1000)
    const since = new Date(end.getTime() - (hour + 1) * 3_600_000)
    const range = `${since.toISOString()}..${until.toISOString()}`
    const path = `actions/runs?per_page=100&created=${encodeURIComponent(range)}`
    const first = await request(path)
    if (first.total_count > 1000) {
      throw new Error('Hourly run inventory exceeds API limit; split the interval')
    }
    runs.push(...first.workflow_runs)
    for (let page = 2; page <= Math.ceil(first.total_count / 100); page++) {
      runs.push(...(await request(`${path}&page=${page}`)).workflow_runs)
    }
  }
  const samples = sampleWorkflowRuns(runs)
  // Bound API concurrency and preserve every selected observation, including zero-job runs.
  for (let index = 0; index < samples.length; index += 4) {
    await Promise.all(
      samples.slice(index, index + 4).map(async (sample) => {
        const path = `actions/runs/${sample.run.id}/jobs?per_page=100`
        const first = await request(path)
        sample.jobs = first.jobs
        for (let page = 2; page <= Math.ceil(first.total_count / 100); page++) {
          sample.jobs.push(...(await request(`${path}&page=${page}`)).jobs)
        }
      })
    )
  }
  const report = {
    start: new Date(end.getTime() - 86_400_000).toISOString(),
    end: end.toISOString(),
    method:
      'Stratified by workflow/conclusion, six sampled runs per stratum; latest attempts only; incomplete jobs excluded',
    ...runnerDemand(runs, samples)
  }
  return { report, runs, samples }
}

export function demandMarkdown(report) {
  return [
    `## CI demand: ${report.start} to ${report.end}`,
    '',
    `Estimated full job duration for runs created in this window (not window-clipped occupancy); ${report.sampledRuns}/${report.populationRuns} runs sampled. ${report.method}.`,
    '',
    '| Workflow | Runs | Runner hours | Cancelled-run hours | Minutes/completed PR run |',
    '| --- | ---: | ---: | ---: | ---: |',
    ...report.workflows.map(
      (row) =>
        `| ${row.workflow} | ${row.runs} | ${(row.runnerMinutes / 60).toFixed(1)} | ${(row.cancelledRunnerMinutes / 60).toFixed(1)} | ${row.runnerMinutesPerCompletedPrRun?.toFixed(1) ?? '—'} |`
    ),
    '',
    '| Runner labels | Hours | Queue/provisioning p95 minutes |',
    '| --- | ---: | ---: |',
    ...report.pools.map(
      (pool) =>
        `| ${pool.label} | ${(pool.runnerMinutes / 60).toFixed(1)} | ${pool.queueP95Minutes?.toFixed(1) ?? '—'} |`
    ),
    ''
  ].join('\n')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const evidence = await collectRunnerDemand()
  mkdirSync('ci-demand', { recursive: true })
  writeFileSync('ci-demand/evidence.json', JSON.stringify(evidence))
  const markdown = demandMarkdown(evidence.report)
  writeFileSync('ci-demand/report.md', markdown)
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown)
  }
}
