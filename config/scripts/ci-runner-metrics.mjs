const minutesBetween = (start, end) => {
  const value = (Date.parse(end) - Date.parse(start)) / 60_000
  return Number.isFinite(value) ? Math.max(0, value) : 0
}

const workflowPath = (run) => run.path.split('@')[0]
const workflowKey = (run) => run.workflow_id ?? workflowPath(run)

export function weightedPercentile(values, percentile) {
  const sorted = [...values].sort((a, b) => a.value - b.value)
  const target = sorted.reduce((sum, item) => sum + item.weight, 0) * percentile
  let seen = 0
  for (const item of sorted) {
    seen += item.weight
    if (seen >= target) {
      return item.value
    }
  }
  return null
}

export function runnerDemand(runs, samples) {
  const workflows = new Map()
  const pools = new Map()
  for (const run of runs) {
    if (!workflows.has(workflowKey(run))) {
      workflows.set(workflowKey(run), {
        workflow: workflowPath(run),
        runs: 0,
        sampledRuns: 0,
        runnerMinutes: 0,
        cancelledRunnerMinutes: 0,
        completedPrRuns: 0,
        completedPrRunnerMinutes: 0
      })
    }
    workflows.get(workflowKey(run)).runs++
  }
  let incompleteJobs = 0
  for (const { run, jobs, weight } of samples) {
    const row = workflows.get(workflowKey(run))
    row.sampledRuns++
    for (const job of jobs) {
      if (!job.runner_name || !job.started_at) {
        continue
      }
      if (!job.completed_at) {
        incompleteJobs++
        continue
      }
      const duration = minutesBetween(job.started_at, job.completed_at)
      const weighted = duration * weight
      row.runnerMinutes += weighted
      if (run.conclusion === 'cancelled') {
        row.cancelledRunnerMinutes += weighted
      }
      if (run.event === 'pull_request' && ['success', 'failure'].includes(run.conclusion)) {
        row.completedPrRunnerMinutes += weighted
      }
      const label = [...job.labels].sort().join(', ') || 'unknown'
      if (!pools.has(label)) {
        pools.set(label, { label, runnerMinutes: 0, waits: [] })
      }
      const pool = pools.get(label)
      pool.runnerMinutes += weighted
      if (job.created_at) {
        pool.waits.push({ value: minutesBetween(job.created_at, job.started_at), weight })
      }
    }
    if (run.event === 'pull_request' && ['success', 'failure'].includes(run.conclusion)) {
      row.completedPrRuns += weight
    }
  }
  return {
    populationRuns: runs.length,
    sampledRuns: samples.length,
    incompleteJobs,
    workflows: [...workflows.values()]
      .map((row) => ({
        ...row,
        runnerMinutesPerCompletedPrRun: row.completedPrRuns
          ? row.completedPrRunnerMinutes / row.completedPrRuns
          : null
      }))
      .sort((a, b) => b.runnerMinutes - a.runnerMinutes),
    pools: [...pools.values()]
      .map(({ waits, ...pool }) => ({ ...pool, queueP95Minutes: weightedPercentile(waits, 0.95) }))
      .sort((a, b) => b.runnerMinutes - a.runnerMinutes)
  }
}

export function sampleWorkflowRuns(runs, perStratum = 6, random = Math.random) {
  const groups = new Map()
  for (const run of runs) {
    const key = `${workflowKey(run)}:${run.conclusion ?? run.status}`
    if (!groups.has(key)) {
      groups.set(key, [])
    }
    groups.get(key).push(run)
  }
  return [...groups.values()].flatMap((group) => {
    const shuffled = [...group]
    for (let index = shuffled.length - 1; index > 0; index--) {
      const target = Math.floor(random() * (index + 1))
      ;[shuffled[index], shuffled[target]] = [shuffled[target], shuffled[index]]
    }
    const selected = shuffled.slice(0, perStratum)
    return selected.map((run) => ({ run, weight: group.length / selected.length }))
  })
}
