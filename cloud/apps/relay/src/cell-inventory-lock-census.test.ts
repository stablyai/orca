import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { cellInventoryLockOptions, type CellInventoryLockMode } from './assignment-store.js'

// Which entry points can reach a call site. A site a sweep can enter must never
// take the bounded wait: its 55P03 becomes a terminal transaction failure, and
// the incident monitor freezes on a single one.
type Reachability = 'request' | 'sweep' | 'both' | 'orphan'

// 'caller' is not a CellInventoryLockMode: those sites take the mode threaded
// from `assign`, which is 'request' for a client and 'pool-default' for the
// evacuateDeadCells sweep.
type CensusMode = CellInventoryLockMode | 'caller'

type CensusEntry = { method: string; mode: CensusMode; reach: Reachability }

// Every lockCellInventory / lockGeneralCellInventory call site in
// assignment-store.ts, in source order. A new site fails this test until it is
// classified here, which is the point.
const CENSUS: CensusEntry[] = [
  { method: 'assignStickyOnce', mode: 'caller', reach: 'both' },
  { method: 'assignOnce', mode: 'caller', reach: 'both' },
  { method: 'assignOnce', mode: 'caller', reach: 'both' },
  { method: 'assignOnce', mode: 'nowait', reach: 'both' },
  { method: 'assignOnce', mode: 'nowait', reach: 'both' },
  { method: 'assignOnce', mode: 'nowait', reach: 'both' },
  { method: 'refreshDrainMigrationLeasesOnce', mode: 'request', reach: 'request' },
  // Reachable from neither: changeActivity has no production callers, only tests.
  { method: 'changeActivity', mode: 'request', reach: 'orphan' },
  { method: 'acquireActivity', mode: 'request', reach: 'request' },
  { method: 'activateControl', mode: 'request', reach: 'request' },
  { method: 'startEvacuation', mode: 'request', reach: 'request' },
  { method: 'completeEvacuationFromDeadSourceOnce', mode: 'request', reach: 'request' },
  { method: 'completeEvacuationFromDeadSourceOnce', mode: 'nowait', reach: 'request' },
  { method: 'supersedeRegisteredEvacuationOnce', mode: 'request', reach: 'request' },
  { method: 'supersedeRegisteredEvacuationOnce', mode: 'nowait', reach: 'request' },
  { method: 'prepareRegisteredCellSupersession', mode: 'request', reach: 'request' },
  { method: 'prepareRegisteredCellSupersession', mode: 'request', reach: 'request' },
  { method: 'completeEvacuation', mode: 'nowait', reach: 'both' },
  { method: 'completeEvacuation', mode: 'pool-default', reach: 'both' },
  { method: 'rebalanceDormant', mode: 'request', reach: 'request' },
  { method: 'startRegionalRehomeCandidate', mode: 'nowait', reach: 'sweep' },
  { method: 'lockedRegionalRehomeFleetSafety', mode: 'nowait', reach: 'sweep' },
  { method: 'completeRegionalRehomeCandidate', mode: 'nowait', reach: 'sweep' },
  { method: 'abortExpiredRegionalRehomes', mode: 'nowait', reach: 'sweep' },
  { method: 'abortExpiredEvacuations', mode: 'nowait', reach: 'sweep' },
  { method: 'abortExpiredEvacuations', mode: 'nowait', reach: 'sweep' },
  { method: 'releaseExpiredActivityLeases', mode: 'nowait', reach: 'sweep' },
  { method: 'releaseExpiredActivity', mode: 'nowait', reach: 'sweep' },
  { method: 'reconcileReservationAccounting', mode: 'pool-default', reach: 'both' },
  { method: 'leastLoadedCell', mode: 'pool-default', reach: 'both' },
  { method: 'removeSupersededSameCellControls', mode: 'request', reach: 'request' }
]

// The background sweeps, and nothing else. A method reachable from one of these
// can be entered by a sweep tick, whatever else can also enter it. Both lists are
// read from source, so a new sweep step or a new route widens the derivation here
// instead of silently widening what a bounded wait can be entered from.
const SWEEP_ENTRY_FILES = ['./assignment-cleanup-steps.ts', './regional-rehome-worker.ts']
const REQUEST_ENTRY_FILES = [
  './app.ts',
  './relay-server.ts',
  './host-session-registry.ts',
  './cell-admission-startup.ts'
]

const DECLARATION = /^ {2}(?:private |public )?(?:static )?(?:async )?([A-Za-z_][\w]*)[(<]/

function storeSource(): string[] {
  return readFileSync(new URL('./assignment-store.ts', import.meta.url), 'utf8').split('\n')
}

function entryPoints(files: string[]): string[] {
  return files.flatMap((file) =>
    [
      ...readFileSync(new URL(file, import.meta.url), 'utf8').matchAll(
        /assignments\.([A-Za-z_][\w]*)\(/g
      )
    ].map((call) => call[1]!)
  )
}

// Same-class call graph: store methods only ever reach each other through `this.`.
function storeCallGraph(lines: string[]): Map<string, Set<string>> {
  const bounds: { name: string; start: number }[] = []
  lines.forEach((line, index) => {
    const declaration = DECLARATION.exec(line)
    if (declaration) bounds.push({ name: declaration[1]!, start: index })
  })
  const callees = new Map<string, Set<string>>()
  bounds.forEach((method, index) => {
    const end = bounds[index + 1]?.start ?? lines.length
    const names = callees.get(method.name) ?? new Set<string>()
    for (const call of lines.slice(method.start, end).join('\n').matchAll(
      /this\.([A-Za-z_][\w]*)\s*\(/g
    )) {
      names.add(call[1]!)
    }
    callees.set(method.name, names)
  })
  return callees
}

function closure(callees: Map<string, Set<string>>, roots: string[]): Set<string> {
  const reached = new Set<string>()
  const pending = [...roots]
  while (pending.length > 0) {
    const name = pending.pop()!
    if (reached.has(name)) continue
    reached.add(name)
    for (const callee of callees.get(name) ?? []) if (!reached.has(callee)) pending.push(callee)
  }
  return reached
}

// Why: a hand-written reachability column is a claim, not a check. Derive both
// directions, so a new sweep edge into a bounded site fails here instead of in
// production, and so 'sweep' and 'both' stop being asserted by hand.
function derivedReachability(lines: string[]): (method: string) => Reachability {
  const callees = storeCallGraph(lines)
  const sweep = closure(callees, entryPoints(SWEEP_ENTRY_FILES))
  const request = closure(callees, entryPoints(REQUEST_ENTRY_FILES))
  return (method) =>
    sweep.has(method)
      ? request.has(method)
        ? 'both'
        : 'sweep'
      : request.has(method)
        ? 'request'
        : 'orphan'
}

function readCallSites(): { method: string; mode: CensusMode }[] {
  const sites: { method: string; mode: CensusMode }[] = []
  let method = '<module>'
  for (const line of storeSource()) {
    const declaration = DECLARATION.exec(line)
    if (declaration) method = declaration[1]!
    if (/private async lock(General)?CellInventory\(/.test(line)) continue
    const call = /lock(?:General)?CellInventory\(\s*\w+\s*,\s*(?:'([a-z-]+)'|(\w+))\s*\)/.exec(line)
    if (!call) continue
    sites.push({ method, mode: (call[1] ?? 'caller') as CensusMode })
  }
  return sites
}

describe('cell inventory lock call-site census', () => {
  it('classifies every call site exactly as recorded', () => {
    expect(readCallSites()).toEqual(
      CENSUS.map(({ method, mode }) => ({ method, mode }))
    )
  })

  it('leaves no call site taking the inventory without naming a mode', () => {
    const source = readFileSync(new URL('./assignment-store.ts', import.meta.url), 'utf8')
    const unclassified = source
      .split('\n')
      .filter((line) => /lock(?:General)?CellInventory\(\s*\w+\s*\)/.test(line))
      .filter((line) => !line.includes('private async'))

    expect(unclassified).toEqual([])
  })

  it('derives the same reachability the census claims', () => {
    const reachOf = derivedReachability(storeSource())

    expect(readCallSites().map(({ method }) => reachOf(method))).toEqual(
      CENSUS.map((entry) => entry.reach)
    )
  })

  // Why: this is the whole point of the classification. A shorter wait on a
  // sweep-reachable site turns contention into a terminal transaction failure,
  // and relayPostgresRetryExhausted freezes the incident gate at zero.
  // Why: the hold distribution is what the 500ms bound will be tuned against, so
  // a mode that stops asking for it goes unmeasured in exactly the lane that
  // matters. Nothing else in the suite reads the pool-default branch.
  it('measures the hold in every lock mode', () => {
    const modes: CellInventoryLockMode[] = ['request', 'nowait', 'pool-default']

    expect(modes.map((mode) => cellInventoryLockOptions(mode).measureHoldMs)).toEqual([
      true,
      true,
      true
    ])
  })

  it('never puts a sweep-reachable site on the bounded wait', () => {
    const reachOf = derivedReachability(storeSource())
    const bounded = readCallSites().filter(
      (site) => site.mode === 'request' && ['sweep', 'both'].includes(reachOf(site.method))
    )

    expect(bounded).toEqual([])
  })

  it('routes every sweep-only site to NOWAIT so it can skip the tick', () => {
    const reachOf = derivedReachability(storeSource())
    const queueing = readCallSites().filter(
      (site) => reachOf(site.method) === 'sweep' && site.mode !== 'nowait'
    )

    expect(queueing).toEqual([])
  })
})
