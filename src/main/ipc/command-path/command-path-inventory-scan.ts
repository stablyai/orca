export type AgentPathMatch = {
  user?: string
  // Null means an earlier candidate could not be verified, so a later hit must use its full path.
  first?: string | null
  unquoted?: string | null
}

export type PathDirectory = { dir: string; key: string; quoted: boolean; runtime: boolean }
export type DirectoryCandidate = { hit?: string; uncertain: boolean }

export function recordDirectoryMatch(
  match: AgentPathMatch,
  dir: PathDirectory,
  { hit, uncertain }: DirectoryCandidate
): string | undefined {
  const winner = uncertain ? null : hit
  if (match.first === undefined) {
    match.first = winner
  }
  if (!dir.quoted && match.unquoted === undefined) {
    match.unquoted = winner
  }
  if (!dir.runtime && hit) {
    match.user ??= hit
  }
  return match.unquoted === undefined ? undefined : match.user
}

export function scanInventoryPathCommand(
  directories: readonly PathDirectory[],
  scan: (dir: PathDirectory) => Promise<DirectoryCandidate>,
  publish: (match: AgentPathMatch) => void,
  signal: AbortSignal
): Promise<boolean> {
  if (directories.length === 0) {
    return Promise.resolve(false)
  }
  const complete = Promise.withResolvers<boolean>()
  const settled = new Map<number, DirectoryCandidate>()
  const match: AgentPathMatch = {}
  let next = 0
  let done = false
  let uncertain = false
  let earliestUser: { index: number; hit: string } | undefined
  for (const [index, dir] of directories.entries()) {
    void scan(dir).then((outcome) => {
      if (done || signal.aborted) {
        complete.resolve(uncertain)
        return
      }
      if (!dir.runtime && outcome.hit && (!earliestUser || index < earliestUser.index)) {
        earliestUser = { index, hit: outcome.hit }
      }
      settled.set(index, outcome)
      for (let entry = settled.get(next); entry; entry = settled.get(next)) {
        settled.delete(next)
        uncertain ||= entry.uncertain
        if (recordDirectoryMatch(match, directories[next++], entry)) {
          done = true
          break
        }
      }
      done ||= next === directories.length
      // Only the settled prefix can prove by-name lookup safe.
      if (earliestUser) {
        publish({ ...match, user: earliestUser.hit })
      } else if (done) {
        publish(match)
      }
      if (done) {
        complete.resolve(uncertain)
      }
    }, complete.reject)
  }
  return complete.promise
}
