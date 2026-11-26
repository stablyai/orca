export type AgentPathMatch = {
  user?: string
  // Null means an earlier candidate blocks safe by-name lookup.
  first?: string | null
  unquoted?: string | null
}

export type PathDirectory = {
  dir: string
  user: boolean
  first?: boolean
  unquoted?: boolean
}
export type DirectoryCandidate = { hit?: string; uncertain: boolean; byName?: boolean }

function trackPathCommand(
  directoryCount: number,
  presenceOnly: boolean,
  publish: (match: AgentPathMatch) => void,
  complete: (uncertain: boolean, verified: boolean) => void
): (index: number, dir: PathDirectory, outcome: DirectoryCandidate) => void {
  const settled = new Map<number, { dir: PathDirectory; outcome: DirectoryCandidate }>()
  const match: AgentPathMatch = {}
  let next = 0
  let uncertain = false
  let earliestUser: { index: number; hit: string } | undefined
  return (index, dir, outcome) => {
    if (presenceOnly && dir.user && outcome.hit) {
      publish({ user: outcome.hit })
      complete(outcome.uncertain, true)
      return
    }
    const previousUser = earliestUser
    const { first, unquoted } = match
    if (dir.user && outcome.hit && (!earliestUser || index < earliestUser.index)) {
      earliestUser = { index, hit: outcome.hit }
    }
    settled.set(index, { dir, outcome })
    let verified = false
    for (let entry = settled.get(next); entry; entry = settled.get(next)) {
      settled.delete(next++)
      const { hit, uncertain: entryUncertain, byName } = entry.outcome
      uncertain ||= entryUncertain
      const winner = entryUncertain || (hit && (!entry.dir.user || !byName)) ? null : hit
      if (entry.dir.first && match.first === undefined) {
        match.first = winner
      }
      if (entry.dir.unquoted && match.unquoted === undefined) {
        match.unquoted = winner
      }
      if (entry.dir.user && hit) {
        verified = true
        break
      }
    }
    const done = verified || next === directoryCount
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
      complete(uncertain, verified)
    }
  }
}

export async function scanInventoryPathCommands<Listing>(
  directories: readonly PathDirectory[],
  commands: ReadonlySet<string>,
  concurrency: number,
  readListing: (dir: PathDirectory, pendingCount: number) => Promise<Listing> | null,
  scan: (
    command: string,
    dir: PathDirectory,
    listing: Listing | null,
    canProbe: boolean
  ) => Promise<DirectoryCandidate>,
  publish: (command: string, match: AgentPathMatch) => void,
  complete: (command: string, uncertain: boolean, verified: boolean) => void,
  { presenceOnly = false, signal }: { presenceOnly?: boolean; signal?: AbortSignal }
): Promise<void> {
  const pending = new Map<
    string,
    { record: ReturnType<typeof trackPathCommand>; firstHit?: number }
  >()
  const allCommandsFound = Promise.withResolvers<void>()
  let hasMiss = false
  for (const command of commands) {
    if (directories.length === 0) {
      complete(command, false, false)
      continue
    }
    pending.set(command, {
      record: trackPathCommand(
        directories.length,
        presenceOnly,
        (match) => publish(command, match),
        (uncertain, verified) => {
          hasMiss ||= !verified
          pending.delete(command)
          complete(command, uncertain, verified)
          // An installer fallback must wait for any outstanding PATH walks.
          if (pending.size === 0 && !hasMiss) {
            allCommandsFound.resolve()
          }
        }
      )
    })
  }
  if (pending.size === 0) {
    return
  }
  let searching = pending.size
  let nextDirectory = 0
  const scanDirectory = async (): Promise<void> => {
    const index = nextDirectory++
    const dir = directories[index]
    const listing = readListing(dir, searching)
    const names = listing === null ? null : await listing
    if (signal?.aborted) {
      return
    }
    await Promise.all(
      [...pending].map(async ([command, state]) => {
        if (state.firstHit !== undefined && index > state.firstHit) {
          return
        }
        // A late listing can prove absence without issuing any new candidate probes.
        const outcome = await scan(command, dir, names, state.firstHit === undefined)
        if (!signal?.aborted && pending.has(command)) {
          if (dir.user && outcome.hit) {
            if (state.firstHit === undefined) {
              searching--
            }
            state.firstHit = Math.min(state.firstHit ?? index, index)
          }
          state.record(index, dir, outcome)
        }
      })
    )
  }
  const run = async (): Promise<void> => {
    while (!signal?.aborted && searching > 0 && nextDirectory < directories.length) {
      await scanDirectory()
    }
  }
  if (signal?.aborted) {
    return
  }
  await scanDirectory()
  await Promise.race([
    allCommandsFound.promise,
    Promise.all(Array.from({ length: concurrency }, run))
  ])
}
