const MAX_CONCURRENT_SKILL_CANDIDATES = 4

export async function runSkillCandidateTasks<T>(
  tasks: readonly (() => Promise<T>)[],
  limit = MAX_CONCURRENT_SKILL_CANDIDATES
): Promise<T[]> {
  const results = Array.from<T>({ length: tasks.length })
  let nextIndex = 0

  async function worker(): Promise<void> {
    for (;;) {
      const index = nextIndex
      nextIndex += 1
      if (index >= tasks.length) {
        return
      }
      results[index] = await tasks[index]()
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, () => worker()))
  return results
}
