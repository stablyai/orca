import type { SessionSearchPassArgs } from './session-search-pass'
import type { SessionSearchDegradedRoot } from './session-search-degraded-roots'
import { sessionSearchEmptiedRoots } from './session-search-scan-roots'
import { isUnderScanRoot } from './session-search-scan-roots'
import { retireDeletedSessionSearchSources } from './session-search-deleted-sources'

export async function retireSessionSearchPassSources(
  args: SessionSearchPassArgs,
  roots: string[],
  rootsWithFiles: Set<string>
): Promise<SessionSearchDegradedRoot[]> {
  const { state, store, signal } = args
  const emptiedRoots = args.previousRootsWithFiles
    ? sessionSearchEmptiedRoots(args.previousRootsWithFiles, rootsWithFiles)
    : new Set<string>()
  const degraded: SessionSearchDegradedRoot[] = []
  if (!state.discovery.walking && state.needsRetirement) {
    state.retirement ??= (async function* () {
      yield* store.fileRows()
    })()
    state.needsRetirement = false
  }
  let batches = 0
  const availableRetirements = state.retire.size
  let consumedRetirements = 0
  do {
    const paths: string[] = []
    const queued = await state.retire.firstPage(
      Math.min(256, availableRetirements - consumedRetirements)
    )
    paths.push(...queued.map(([path]) => path))
    consumedRetirements += queued.length
    const inspected = []
    while (state.retirement && paths.length + inspected.length < 256) {
      const row = await state.retirement.next()
      if (row.done) {
        state.retirement = null
        break
      }
      inspected.push({ path: row.value.path, agent: row.value.agent })
    }
    if (inspected.length) {
      const queuedPaths = new Set(paths)
      paths.push(
        ...(await state.candidates.unowned(inspected)).filter((path) => !queuedPaths.has(path))
      )
    }
    if (!paths.length) {
      if (!state.retirement || args.discoveryOverdue?.()) {
        break
      }
      continue
    }
    const retirement = await retireDeletedSessionSearchSources({
      store,
      paths,
      roots,
      emptiedRoots,
      enumeratedContainers: state.discovery.enumeratedContainers,
      listings: args.listings,
      directoryLimit: 512,
      signal
    })
    await state.retire.deletePage(queued.map(([path]) => path))
    await state.retire.setPage(retirement.unchecked.map((path) => [path, path] as const))
    const emptied = (path: string) => [...emptiedRoots].some((root) => isUnderScanRoot(path, root))
    await state.retire.setPage(
      retirement.unverifiable.filter(emptied).map((path) => [path, path] as const)
    )
    await state.parkedRetire.setPage(
      retirement.unverifiable.filter((path) => !emptied(path)).map((path) => [path, path] as const)
    )
    degraded.push(...retirement.degradedRoots)
    // Retry refused paths next cycle, but keep advancing the older retirement frontier now.
    batches++
  } while (
    (state.retirement || consumedRetirements < availableRetirements) &&
    (batches === 0 || !args.discoveryOverdue?.())
  )
  return degraded
}
