export function selectChangedCheckTasks(tasks, group = 'all') {
  if (group === 'all') {
    return tasks
  }
  if (group === 'types-and-tests') {
    return tasks.filter((task) => task.exclusive)
  }
  if (group === 'static') {
    return tasks.filter((task) => !task.exclusive)
  }
  throw new Error(`Unknown check group: ${group}`)
}

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
