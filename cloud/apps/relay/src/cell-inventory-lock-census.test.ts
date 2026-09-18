import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { cellInventoryLockOptions, type CellInventoryLockMode } from './assignment-store.js'

// Which entry points can reach a call site. A site a sweep can enter must never
// take the bounded wait: its 55P03 becomes a terminal transaction failure, and
// the incident monitor freezes on a single one.
type Reachability = 'request' | 'sweep' | 'both' | 'orphan'

// 'caller' is not a CellInventoryLockMode: those sites take the mode threaded
// from `assign`, which is 'request' for a client and 'pool-default' for the
// evacuateDeadCells sweep. 'unset' is a lockCellRows call that passes no mode
// and therefore takes the parameter default, which is the bounded wait.
type CensusMode = CellInventoryLockMode | 'caller' | 'unset'

type CensusEntry = { method: string; mode: CensusMode; reach: Reachability }

// Every call site of a named cell lock helper in assignment-store.ts, in source
// order. A new site fails this test until it is classified here, which is the
// point. lockCellRows is censused alongside the inventory locks: converting a
// site from one to the other must not move it out of the mode policy below.
const CENSUS: CensusEntry[] = [
  // Sticky refresh locks only the row the host is pinned to, and threads the
  // caller's mode. Placement below is the one genuinely fleet-wide decision left.
  { method: 'assignStickyOnce', mode: 'caller', reach: 'both' },
  { method: 'assignOnce', mode: 'caller', reach: 'both' },
  { method: 'assignOnce', mode: 'caller', reach: 'both' },
  { method: 'assignOnce', mode: 'nowait', reach: 'both' },
  { method: 'assignOnce', mode: 'nowait', reach: 'both' },
  { method: 'assignOnce', mode: 'nowait', reach: 'both' },
  { method: 'refreshDrainMigrationLeasesOnce', mode: 'request', reach: 'request' },
  // changeActivity, acquireActivity, activateControl and
  // removeSupersededSameCellControls no longer take the inventory: they lock
  // only the one or two cell rows they touch, in cell_id order (lockCellRows),
  // so they cannot cycle with placement's ordered inventory lock, and the
  // 23-row lock there had serialised every reconnect in the fleet behind every
  // other one.
  { method: 'acquireActivity', mode: 'request', reach: 'request' },
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
  { method: 'startRegionalRehomeCandidate', mode: 'nowait', reach: 'request' },
  { method: 'completeRegionalRehomeCandidate', mode: 'nowait', reach: 'sweep' },
  { method: 'abortExpiredRegionalRehomes', mode: 'nowait', reach: 'sweep' },
  { method: 'abortExpiredEvacuations', mode: 'nowait', reach: 'sweep' },
  { method: 'abortExpiredEvacuations', mode: 'nowait', reach: 'sweep' },
  { method: 'releaseExpiredActivityLeases', mode: 'nowait', reach: 'sweep' },
  { method: 'releaseExpiredActivity', mode: 'nowait', reach: 'sweep' },
  // Repairs exactly two cells' counters and holds only those rows. leastLoadedCell
  // is absent because it selects from the inventory its single caller already locked.
  { method: 'reconcileReservationAccounting', mode: 'pool-default', reach: 'both' },
  { method: 'removeSupersededSameCellControls', mode: 'request', reach: 'request' }
]

// Every statement outside the named lock helpers that takes a relay_cells row
// lock, as `file:method` in file-then-source order: whole-table locks in
// reconciliation, sticky placement and the admission boundary, and per-cell
// locks or writes for a cell the method is already scoped to (heartbeat, fence,
// drain generation, configuration, cell registration, or a reservation adjust
// that runs under a lock its caller already holds). A new one fails the census
// below until it is listed here; per-connection paths that touch more than one
// cell go through lockCellRows so the order is fixed.
const NAMED_LOCK_HELPERS = ['lockCellInventory', 'lockGeneralCellInventory', 'lockCellRows']

const CELL_ROW_LOCK_SITES = [
  'assignment-store.ts:reconcileCellsWithOptions',
  'assignment-store.ts:reconcileCellsWithOptions',
  'assignment-store.ts:assignStickyOnce',
  'assignment-store.ts:recordCellHeartbeat',
  'assignment-store.ts:recordCellHeartbeat',
  'assignment-store.ts:attestCellFence',
  'assignment-store.ts:adoptLegacyCellFence',
  'assignment-store.ts:commitLegacyCellFenceAdoption',
  'assignment-store.ts:prepareCellFenceAttempt',
  'assignment-store.ts:attestCellFenceAttempt',
  'assignment-store.ts:attestCellFenceAttempt',
  'assignment-store.ts:configureCell',
  'assignment-store.ts:configureCell',
  'assignment-store.ts:reconcileReservationAccounting',
  'assignment-store.ts:assertDrainCellGeneration',
  'assignment-store.ts:removeSupersededSameCellControls',
  'assignment-store.ts:adjustCellReservation',
  'assignment-store.ts:adjustCellReservation',
  'assignment-store.ts:adjustCellReservationAtomically',
  'cell-admission-migration-registration.ts:add',
  'cell-admission-migration-registration.ts:insertCell',
  'cell-admission-selector.ts:setCellAdmissionBeforeBoundary',
  'cell-admission-selector.ts:setCellAdmissionBeforeBoundary',
  'cell-admission-selector.ts:apply',
  'cell-admission-selector.ts:apply',
  'cell-admission-selector.ts:inspect',
  'cell-admission-selector.ts:persistIntent'
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
// The selector and the registrar are modules of free functions, not store methods.
const FUNCTION_DECLARATION = /^(?:export )?(?:async )?function ([A-Za-z_][\w]*)[(<]/

const SOURCE_DIRECTORY = fileURLToPath(new URL('.', import.meta.url))

// The lock census is store-scoped on purpose: lockCellInventory is private, so
// only this class can reach it, and the call graph below is same-class.
function storeSource(): string[] {
  return readFileSync(join(SOURCE_DIRECTORY, 'assignment-store.ts'), 'utf8').split('\n')
}

function relaySourceFiles(): string[] {
  return readdirSync(SOURCE_DIRECTORY, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .filter((entry) => !entry.name.endsWith('.test.ts'))
    .map((entry) => relative(SOURCE_DIRECTORY, join(entry.parentPath, entry.name)))
    .sort()
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
    for (const call of lines
      .slice(method.start, end)
      .join('\n')
      .matchAll(/this\.([A-Za-z_][\w]*)\s*\(/g)) {
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

// Whole statements, not a fixed window: a wide column list or a raw FOR UPDATE
// inside query() must not slip past.
const TICK = String.fromCharCode(96)
const STATEMENT_CALL = '\\.(queryLocked|query)\\(\\s*' + TICK + '([^' + TICK + ']*)' + TICK
const CELL_TABLE_READ = /\bFROM\s+relay_cells\b/
// A bare write takes the same row lock with no SELECT in front of it, so a
// FROM-only detector is blind to exactly the statements a per-cell conversion
// has to move.
const CELL_ROW_WRITE = /^\s*(?:UPDATE|INSERT INTO|DELETE FROM)\s+relay_cells\b/

function methodLocator(source: string): (offset: number) => string {
  const bounds: { name: string; start: number }[] = []
  source.split('\n').forEach((line, index) => {
    const declaration = DECLARATION.exec(line) ?? FUNCTION_DECLARATION.exec(line)
    if (declaration) bounds.push({ name: declaration[1]!, start: index })
  })
  return (offset) => {
    const lineIndex = source.slice(0, offset).split('\n').length - 1
    let name = '<module>'
    for (const bound of bounds) if (bound.start <= lineIndex) name = bound.name
    return name
  }
}

function cellRowLockSites(file: string, source: string): string[] {
  const methodAt = methodLocator(source)
  const sites: string[] = []
  for (const call of source.matchAll(new RegExp(STATEMENT_CALL, 'g'))) {
    const statement = call[2]!
    const writes = CELL_ROW_WRITE.test(statement)
    if (!writes && !CELL_TABLE_READ.test(statement)) continue
    if (!writes && call[1] !== 'queryLocked' && !/\bFOR\s+UPDATE\b/.test(statement)) continue
    const method = methodAt(call.index)
    if (NAMED_LOCK_HELPERS.includes(method)) continue
    sites.push(`${file}:${method}`)
  }
  return sites
}

type CensusSite = { method: string; helper: string; mode: CensusMode }

// 'unset' cannot occur while lockCellRows has no mode default, and is kept so
// that reintroducing one lands a site on the bounded wait here rather than in
// production. The test below is what keeps the two claims in step.
const BOUNDED_WAIT_MODES: CensusMode[] = ['request', 'unset']
const CELL_ROWS_MODE_DEFAULT = /mode: CellInventoryLockMode\s*=/

const HELPER_CALL = new RegExp(`\\b(${NAMED_LOCK_HELPERS.join('|')})\\(`, 'g')
const QUOTED_MODE = /^'([a-z-]+)'$/

// lockCellRows takes the cell list before its mode; the inventory locks take the
// mode second. An out-of-range index means the call omitted it.
function modeArgument(helper: string): number {
  return helper === 'lockCellRows' ? 2 : 1
}

// Top-level arguments of the call whose '(' is at `open`. A line-scoped regex
// cannot read lockCellRows calls: they pass array literals and wrap across
// lines. Assumes no brackets inside string arguments, which holds for all modes.
function callArguments(source: string, open: number): string[] {
  const args: string[] = []
  let depth = 0
  let start = open + 1
  for (let index = open; index < source.length; index++) {
    const character = source[index]!
    if ('(['.includes(character) || character === '{') depth++
    else if (')]'.includes(character) || character === '}') {
      depth--
      if (depth > 0) continue
      args.push(source.slice(start, index))
      return args.map((argument) => argument.trim()).filter((argument) => argument !== '')
    } else if (character === ',' && depth === 1) {
      args.push(source.slice(start, index))
      start = index + 1
    }
  }
  return []
}

function readCallSites(): CensusSite[] {
  const source = storeSource().join('\n')
  const methodAt = methodLocator(source)
  const sites: CensusSite[] = []
  for (const call of source.matchAll(HELPER_CALL)) {
    const method = methodAt(call.index)
    if (NAMED_LOCK_HELPERS.includes(method)) continue
    const helper = call[1]!
    const argument = callArguments(source, call.index + call[0].length - 1)[modeArgument(helper)]
    const mode = argument === undefined ? 'unset' : (QUOTED_MODE.exec(argument)?.[1] ?? 'caller')
    sites.push({ method, helper, mode: mode as CensusMode })
  }
  return sites
}

describe('cell inventory lock call-site census', () => {
  it('classifies every call site exactly as recorded', () => {
    expect(readCallSites().map(({ method, mode }) => ({ method, mode }))).toEqual(
      CENSUS.map(({ method, mode }) => ({ method, mode }))
    )
  })

  // Why: the census only sees lockCellInventory calls, so a hand-written
  // `relay_cells ... FOR UPDATE` would escape classification entirely.
  it('routes every relay_cells row lock through a named lock helper', () => {
    const sites = relaySourceFiles().flatMap((file) =>
      cellRowLockSites(file, readFileSync(join(SOURCE_DIRECTORY, file), 'utf8'))
    )

    expect(sites).toEqual(CELL_ROW_LOCK_SITES)
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
  // sweep-reachable site turns contention into a terminal transaction failure
  // that counts against the incident gate's relayPostgresRetryExhausted bar.
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
      (site) =>
        BOUNDED_WAIT_MODES.includes(site.mode) && ['sweep', 'both'].includes(reachOf(site.method))
    )

    expect(bounded).toEqual([])
  })

  // Why: an omitted mode used to mean the bounded wait, which is the one policy
  // a sweep must never take. There is no default to fall back on now, so the
  // compiler enforces what this census could only observe after the fact.
  it('leaves lockCellRows no mode default to fall back on', () => {
    const lines = storeSource()
    const declaration = lines
      .slice(lines.findIndex((line) => line.includes('private async lockCellRows(')))
      .slice(0, 8)
      .join('\n')

    expect(CELL_ROWS_MODE_DEFAULT.test(declaration)).toBe(false)
  })

  // Why: converting a sweep site from lockCellInventory to lockCellRows is the
  // planned change, and `lockCellRows(transaction, [cellId])` reads as harmless.
  // NOWAIT never waits, so it can never be an edge in a wait-for cycle; the
  // default turns that into a 500ms wait and creates the edge a cycle needs.
  it('never lets a sweep-reachable lockCellRows call default its mode', () => {
    const reachOf = derivedReachability(storeSource())
    const defaulted = readCallSites().filter(
      (site) =>
        site.helper === 'lockCellRows' &&
        site.mode === 'unset' &&
        ['sweep', 'both'].includes(reachOf(site.method))
    )

    expect(
      defaulted,
      'lockCellRows defaults mode to the bounded wait; a sweep must pass nowait explicitly'
    ).toEqual([])
  })

  it('routes every sweep-only site to NOWAIT so it can skip the tick', () => {
    const reachOf = derivedReachability(storeSource())
    const queueing = readCallSites().filter(
      (site) => reachOf(site.method) === 'sweep' && site.mode !== 'nowait'
    )

    expect(queueing).toEqual([])
  })
})
