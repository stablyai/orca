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
    while (state.retire.size && paths.length < 512 && consumedRetirements < availableRetirements) {
      const first = await state.retire.firstEntry()
      if (!first) {
        break
      }
      await state.retire.delete(first[0])
      paths.push(first[0])
      consumedRetirements++
    }
    let inspected = 0
    while (state.retirement && paths.length < 512 && inspected++ < 512) {
      const row = await state.retirement.next()
      if (row.done) {
        state.retirement = null
        break
      }
      if (!(await state.candidates.has(row.value.path, row.value.agent))) {
        paths.push(row.value.path)
      }
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
    for (const path of retirement.unchecked) {
      await state.retire.set(path, path)
    }
    for (const path of retirement.unverifiable) {
      await (
        [...emptiedRoots].some((root) => isUnderScanRoot(path, root))
          ? state.retire
          : state.parkedRetire
      ).set(path, path)
    }
    degraded.push(...retirement.degradedRoots)
    // Retry refused paths next cycle, but keep advancing the older retirement frontier now.
    batches++
  } while (
    (state.retirement || consumedRetirements < availableRetirements) &&
    (batches === 0 || !args.discoveryOverdue?.())
  )
  return degraded
}
