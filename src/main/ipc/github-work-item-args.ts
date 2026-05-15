export type WorkItemArgs = {
  repoPath: string
  number: number
  type?: 'issue' | 'pr'
}

type RegisteredRepoContext = {
  path: string
  connectionId?: string | null
}

// Why: renderer input crosses the IPC boundary and is untrusted. Reject
// non-integer or < 1 numbers, and coerce unrecognised `type` values to
// undefined so getWorkItem falls through to its issue-then-PR probe rather
// than silently dispatching to the wrong branch.
export function dispatchWorkItem<T>(
  args: WorkItemArgs,
  repo: RegisteredRepoContext,
  fn: (
    path: string,
    n: number,
    t?: 'issue' | 'pr',
    connectionId?: string | null
  ) => Promise<T | null>
): Promise<T | null> | null {
  const { number, type } = args
  if (typeof number !== 'number' || !Number.isInteger(number) || number < 1) {
    return null
  }
  const safeType = type === 'issue' || type === 'pr' ? type : undefined
  return fn(repo.path, number, safeType, repo.connectionId ?? null)
}
