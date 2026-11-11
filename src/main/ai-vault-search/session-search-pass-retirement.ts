import type { SessionSearchPassArgs } from './indexing/session-search-pass'
import type { SessionSearchDegradedRoot } from './discovery/session-search-degraded-roots'
import { sessionSearchEmptiedRoots, isUnderScanRoot } from './discovery/session-search-scan-roots'
import { retireDeletedSessionSearchSources } from './discovery/session-search-deleted-sources'

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
    state.retirement ??= {
      iterator: (async function* () {
        yield* store.fileRows()
      })(),
      rows: [],
      exhausted: false
    }
    state.needsRetirement = false
  }
  const cutoff = await state.retire.snapshot()
  while (true) {
    const unit = state.retirement
    const queued =
      unit?.rows.length || (unit && state.retirementTurn === 'sweep')
        ? []
        : await state.retire.receipts(256, cutoff)
    const paths = queued.map(({ key }) => key)
    if (unit && !unit.rows.length && !queued.length) {
      let bytes = 1024
      while (!unit.exhausted && paths.length + unit.rows.length < 256) {
        let value = unit.lookahead
        if (value) {
          unit.lookahead = undefined
        } else {
          const next = await unit.iterator.next()
          if (next.done) {
            unit.exhausted = true
            break
          }
          value = { path: next.value.path, agent: next.value.agent }
        }
        const size = JSON.stringify(value).length * 2 + 64
        if (unit.rows.length && bytes + size > 256 * 1024) {
          unit.lookahead = value
          break
        }
        unit.rows.push(value)
        bytes += size
      }
    }
    if (unit?.rows.length) {
      const queuedPaths = new Set(paths)
      paths.push(
        ...(await state.candidates.unowned(unit.rows)).filter((path) => !queuedPaths.has(path))
      )
    }
    if (paths.length) {
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
      const emptied = (path: string) =>
        [...emptiedRoots].some((root) => isUnderScanRoot(path, root))
      const outcomes = new Map<string, 'retry' | 'parked'>([
        ...retirement.unchecked.map((key) => [key, 'retry'] as const),
        ...retirement.unverifiable.map((key) => [key, emptied(key) ? 'retry' : 'parked'] as const)
      ])
      const receipts = new Map(queued.map(({ key, revision }) => [key, revision]))
      await state.retire.settlePaths(
        state.parkedRetire,
        cutoff,
        paths.map((key) => ({ key, revision: receipts.get(key), outcome: outcomes.get(key) }))
      )
      degraded.push(...retirement.degradedRoots)
    }
    state.retirementTurn = queued.length ? 'sweep' : 'queued'
    if (unit && !queued.length) {
      unit.rows.length = 0
      if (unit.exhausted && !unit.lookahead) {
        state.retirement = null
      }
    }
    if ((!state.retirement && !queued.length && !unit) || args.discoveryOverdue?.()) {
      break
    }
  }
  return degraded
}
