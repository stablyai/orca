const executionKey = (job) =>
  job.name &&
  job.runner_name &&
  job.started_at &&
  job.completed_at &&
  Number.isSafeInteger(job.run_attempt) &&
  job.run_attempt > 0
    ? JSON.stringify([job.name, job.runner_name, job.started_at, job.completed_at])
    : null

export function jobExecutions(jobs) {
  const firstAttempt = new Map()
  // Failed-only retries copy completed jobs with new IDs and the original execution timestamps.
  for (const job of jobs) {
    const key = executionKey(job)
    if (key !== null) {
      firstAttempt.set(key, Math.min(firstAttempt.get(key) ?? Infinity, job.run_attempt))
    }
  }
  return jobs.filter((job) => {
    const key = executionKey(job)
    return key === null || firstAttempt.get(key) === job.run_attempt
  })
}
