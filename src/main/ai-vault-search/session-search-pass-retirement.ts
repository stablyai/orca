import type { SessionSearchPassArgs } from './session-search-pass'
import type { SessionSearchDegradedRoot } from './session-search-degraded-roots'
import { sessionSearchEmptiedRoots, isUnderScanRoot } from './session-search-scan-roots'
import { retireDeletedSessionSearchSources } from './session-search-deleted-sources'

export async function wakeSessionSearchPassRetirements(args: SessionSearchPassArgs): Promise<void> {
  if (args.full || args.purge) {
    await args.state.parkedRetire.wake()
  }
  while (args.state.parkedRetire.waking) {
    await args.state.parkedRetire.movePageTo(args.state.retire)
    if (args.discoveryOverdue?.()) {
      break
    }
  }
}

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
    const remaining = availableRetirements - consumedRetirements
    const queued = remaining > 0 ? await state.retire.receipts(Math.min(256, remaining)) : []
    paths.push(...queued.map(({ key }) => key))
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
    await state.retire.acknowledge(queued)
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
