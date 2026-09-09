/**
 * Commits reservation-bearing metadata or removes the just-created provider resource. A rollback
 * failure is preserved beside the persistence error so callers never mistake the orphan for a
 * clean failure that is safe to retry.
 */
export async function persistCreatedWorktreeOrRollback<T>(args: {
  resourcePath: string
  persist: () => T
  rollback: () => Promise<unknown>
}): Promise<T> {
  try {
    return args.persist()
  } catch (persistenceError) {
    try {
      await args.rollback()
    } catch (rollbackError) {
      throw new AggregateError(
        [persistenceError, rollbackError],
        `Worktree metadata persistence failed and rollback failed for ${args.resourcePath}`
      )
    }
    throw persistenceError
  }
}
