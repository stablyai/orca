async function runConcurrent(tasks, concurrency, run, signal) {
  const results = []
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
      while (!signal?.aborted && next < tasks.length) {
        results.push(await run(tasks[next++]))
      }
    })
  )
  return results
}

export async function runChangedCheckTasks(
  tasks,
  concurrency,
  run,
  signal,
  { isolateResourceChecks = false } = {}
) {
  if (!isolateResourceChecks) {
    return runConcurrent(tasks, concurrency, run, signal)
  }
  const results = []
  for (const task of tasks.filter((task) => task.exclusive)) {
    if (signal?.aborted) {
      return results
    }
    results.push(await run(task))
  }
  return results.concat(
    await runConcurrent(
      tasks.filter((task) => !task.exclusive),
      concurrency,
      run,
      signal
    )
  )
}
