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

function trackPathCommand(
  directoryCount: number,
  publish: (match: AgentPathMatch) => void,
  complete: (uncertain: boolean) => void
): (index: number, dir: PathDirectory, outcome: DirectoryCandidate) => void {
  const settled = new Map<number, { dir: PathDirectory; outcome: DirectoryCandidate }>()
  const match: AgentPathMatch = {}
  let next = 0
  let uncertain = false
  let earliestUser: { index: number; hit: string } | undefined
  return (index, dir, outcome) => {
    const previousUser = earliestUser
    const { first, unquoted } = match
    if (!dir.runtime && outcome.hit && (!earliestUser || index < earliestUser.index)) {
      earliestUser = { index, hit: outcome.hit }
    }
    settled.set(index, { dir, outcome })
    let done = false
    for (let entry = settled.get(next); entry; entry = settled.get(next)) {
      settled.delete(next++)
      uncertain ||= entry.outcome.uncertain
      if (recordDirectoryMatch(match, entry.dir, entry.outcome)) {
        done = true
        break
      }
    }
    done ||= next === directoryCount
    if (
      done ||
      previousUser !== earliestUser ||
      first !== match.first ||
      unquoted !== match.unquoted
    ) {
      // Only the settled prefix can prove by-name lookup safe.
      publish({ ...match, user: earliestUser?.hit })
    }
    if (done) {
      complete(uncertain)
    }
  }
}

export async function scanInventoryPathCommands(
  directories: readonly PathDirectory[],
  commands: ReadonlySet<string>,
  concurrency: number,
  scan: (command: string, dir: PathDirectory) => Promise<DirectoryCandidate>,
  publish: (command: string, match: AgentPathMatch) => void,
  complete: (command: string, uncertain: boolean) => void,
  signal: AbortSignal
): Promise<void> {
  const pending = new Map<string, ReturnType<typeof trackPathCommand>>()
  const allCommandsDecided = Promise.withResolvers<void>()
  for (const command of commands) {
    if (directories.length === 0) {
      complete(command, false)
      continue
    }
    pending.set(
      command,
      trackPathCommand(
        directories.length,
        (match) => publish(command, match),
        (uncertain) => {
          pending.delete(command)
          complete(command, uncertain)
          if (pending.size === 0) {
            allCommandsDecided.resolve()
          }
        }
      )
    )
  }
  if (pending.size === 0) {
    return
  }
  let nextDirectory = 0
  const scanDirectory = async (): Promise<void> => {
    const index = nextDirectory++
    const dir = directories[index]
    await Promise.all(
      [...pending].map(async ([command, record]) => {
        const outcome = await scan(command, dir)
        if (!signal.aborted && pending.has(command)) {
          record(index, dir, outcome)
        }
      })
    )
  }
  const run = async (): Promise<void> => {
    while (!signal.aborted && pending.size && nextDirectory < directories.length) {
      await scanDirectory()
    }
  }
  await scanDirectory()
  await Promise.race([
    allCommandsDecided.promise,
    Promise.all(Array.from({ length: concurrency }, run))
  ])
}
