import {
  createProcessTableSnapshotReader,
  PROCESS_TABLE_SNAPSHOT_MAX_STALENESS_MS
} from '../../shared/process-table-snapshot-reader'
import { reportWindowsCommandLineRecoveryHealth } from './windows-command-line-recovery-health'
import { readWindowsProcessRowsWithCim } from './windows-process-table-cim-scan'
import { WindowsProcessTableTimeoutError } from './windows-process-table-timeout-error'
import {
  loadWindowsProcessTree,
  PROCESS_DATA_FLAG,
  resetCachedModuleForTests,
  setNativeRequireForTests,
  type NativeProcessInfo,
  type NativeRequire,
  type WindowsProcessTreeModule
} from './windows-process-tree-loader'

/** Shared Windows snapshots: serialized native identity/command-line views, with CIM fallback only when no usable binding exists. Both views request creation times through limited query handles; Memory stays off. See docs/reference/windows-process-enumeration.md. */

/** PID/parent/name identity, with native creation time when available. */
export type WindowsProcessIdentityRow = {
  pid: number
  ppid: number
  name: string
  /** Process creation time in Unix milliseconds, when the native snapshot provides it. */
  creationTimeMs?: number
}

/** Adds the kernel-supplied command line. Only ask for this if you read it. */
export type WindowsProcessRow = WindowsProcessIdentityRow & {
  /** Full command line. Empty when the process denied a query handle. */
  command: string
}

/** Warn once where stderr survives; daemon startup reports capability through daemonLog instead. */
let warnedAboutCimFallback = false

let moduleLoader: () => WindowsProcessTreeModule | null = loadWindowsProcessTree
let cimScan: () => Promise<WindowsProcessRow[]> = readWindowsProcessRowsWithCim

/** Bound a native read: a missing callback otherwise strands every queued caller. */
const WINDOWS_PROCESS_QUERY_TIMEOUT_MS = 3_000

/** Block native re-entry after timeout until that read's own callback drains. One shared gate bounds retained callbacks/workers across both flag sets; monotonic IDs prevent stale callbacks clearing newer wedges. */
const unreturnedReads = new Set<number>()
let readSequence = 0
let nativeReaderEpoch = 0

/** Serialize both flag sets: the npm wrapper coalesces overlapping callers and discards later flags; the bare addon has no queue and can crash on overlap. Deadline rejection lets waiters recheck outstanding work instead of stranding them. */
let nativeReadGate: Promise<unknown> = Promise.resolve()

function resetNativeReaderState(): void {
  nativeReaderEpoch += 1
  warnedAboutCimFallback = false
  unreturnedReads.clear()
  // Chain rather than replace: existing waiters must not run beside newly queued reads.
  nativeReadGate = nativeReadGate.then(ignoreSettlement, ignoreSettlement)
}

/** A flag set and the row shape it can honestly produce. */
type ProcessRowProjection<Row> = {
  flags: (native: WindowsProcessTreeModule) => number
  fromNative: (row: NativeProcessInfo) => Row
  /** Only detailed rows run CIM; identity projects that same expensive scan instead of spawning another. */
  cimFallback?: () => Promise<Row[]>
}

function toIdentityRow(row: {
  pid: number
  ppid: number
  name: string
  creationTimeMs?: number
}): WindowsProcessIdentityRow {
  return {
    pid: row.pid,
    ppid: row.ppid,
    name: row.name,
    ...(typeof row.creationTimeMs === 'number' ? { creationTimeMs: row.creationTimeMs } : {})
  }
}

/** Request creation time via limited query handles when supported; identity omits command lines and never reads process memory. */
const IDENTITY_PROJECTION: ProcessRowProjection<WindowsProcessIdentityRow> = {
  flags: (native) => native.ProcessDataFlag.None | (native.ProcessDataFlag.CreationTime ?? 0),
  fromNative: toIdentityRow
}

/** Add kernel command-line queries through limited handles. Omit unused Memory: it requests VM_READ and its working set wraps above 4GB. */
const DETAILED_PROJECTION: ProcessRowProjection<WindowsProcessRow> = {
  flags: (native) => IDENTITY_PROJECTION.flags(native) | native.ProcessDataFlag.CommandLine,
  fromNative: (row) => ({ ...toIdentityRow(row), command: row.commandLine ?? '' }),
  cimFallback: readCimRows
}

function ignoreSettlement(): void {}

function readNativeRows<Row>(projection: ProcessRowProjection<Row>): Promise<Row[]> {
  const attempt = nativeReadGate.then(() => readOneSnapshot(projection))
  nativeReadGate = attempt.then(ignoreSettlement, ignoreSettlement)
  return attempt
}

function readOneSnapshot<Row>(projection: ProcessRowProjection<Row>): Promise<Row[]> {
  const native = moduleLoader()
  if (!native) {
    if (process.platform === 'win32' && projection.cimFallback) {
      // Only missing/unusable bindings use CIM; native failure/timeouts must not fork shells at poll cadence.
      if (!warnedAboutCimFallback) {
        warnedAboutCimFallback = true
        console.warn(
          '[windows-process-table] no native binding; falling back to a powershell.exe CIM scan at each caller poll. See docs/reference/windows-process-enumeration.md.'
        )
      }
      return projection.cimFallback()
    }
    // Reject missing evidence; an empty table would falsely prove tree death.
    return Promise.reject(new Error('windows process table unavailable'))
  }
  if (unreturnedReads.size > 0) {
    return Promise.reject(
      new WindowsProcessTableTimeoutError(
        'windows process table is wedged: an earlier read has not returned'
      )
    )
  }
  const readId = ++readSequence
  const readerEpoch = nativeReaderEpoch
  const flags = projection.flags(native)
  return new Promise((resolve, reject) => {
    // Synchronous native throws must clear the deadline or it could wedge a recovered reader.
    let deadline: ReturnType<typeof setTimeout> | undefined
    try {
      deadline = setTimeout(() => {
        // Test resets invalidate deadlines owned by the prior injected reader.
        if (readerEpoch === nativeReaderEpoch) {
          unreturnedReads.add(readId)
        }
        reject(new WindowsProcessTableTimeoutError('windows process table timed out'))
      }, WINDOWS_PROCESS_QUERY_TIMEOUT_MS)
      deadline.unref?.()
      native.getAllProcesses((processes) => {
        clearTimeout(deadline)
        // Only this read's callback proves its outstanding native work drained.
        unreturnedReads.delete(readId)
        if (!processes) {
          reject(new Error('windows process table returned no snapshot'))
          return
        }
        // Missing self means unreadable/truncated data, never proof that no processes run.
        if (!processes.some((row) => row.pid === process.pid)) {
          reject(new Error('windows process table is unreadable'))
          return
        }
        // Only meaningful when a command line was actually asked for.
        if ((flags & native.ProcessDataFlag.CommandLine) !== 0) {
          reportWindowsCommandLineRecoveryHealth(processes)
        }
        resolve(processes.map(projection.fromNative))
      }, flags)
    } catch (error) {
      clearTimeout(deadline)
      reject(error instanceof Error ? error : new Error(String(error)))
    }
  })
}

/** Reject CIM tables missing self: truncated/filtered results cannot prove process death. */
async function readCimRows(): Promise<WindowsProcessRow[]> {
  const rows = await cimScan()
  if (!rows.some((row) => row.pid === process.pid)) {
    throw new Error('windows process table is unreadable')
  }
  return rows
}

/** Expensive fallback scans take ~1.3s and spawn PowerShell; cache them longer than native in-process reads. */
export const CIM_PROCESS_TABLE_SNAPSHOT_TTL_MS = 10_000

// TTL/single-flight caches collapse teardown bursts into at most one scan per flag set.
const makeReader = <Row>(projection: ProcessRowProjection<Row>) =>
  createProcessTableSnapshotReader<Row[]>({
    runPs: () => readNativeRows(projection),
    now: () => Date.now(),
    ttlMs: () =>
      moduleLoader() === null
        ? CIM_PROCESS_TABLE_SNAPSHOT_TTL_MS
        : PROCESS_TABLE_SNAPSHOT_MAX_STALENESS_MS
  })
const identityReader = makeReader(IDENTITY_PROJECTION)
const detailedReader = makeReader(DETAILED_PROJECTION)

/** Without a binding, project identity from the shared CIM scan and strip command lines to preserve the row contract. */
async function readIdentityRows(fresh: boolean): Promise<WindowsProcessIdentityRow[]> {
  if (moduleLoader() === null) {
    const rows = await (fresh ? detailedReader.getFreshSnapshot() : detailedReader.getSnapshot())
    return rows.map(toIdentityRow)
  }
  return fresh ? identityReader.getFreshSnapshot() : identityReader.getSnapshot()
}

/** Cached command-line snapshot, refreshed on the shared TTL. */
export function readWindowsProcessTable(): Promise<WindowsProcessRow[]> {
  return detailedReader.getSnapshot()
}

/** Fresh teardown evidence must start after this call; cached rows may predate exit. */
export function readWindowsProcessTableFresh(): Promise<WindowsProcessRow[]> {
  return detailedReader.getFreshSnapshot()
}

/** Cached identity; prefer it when no command line is needed. */
export function readWindowsProcessIdentityTable(): Promise<WindowsProcessIdentityRow[]> {
  return readIdentityRows(false)
}

/** The identity snapshot, from a scan that starts after this call. */
export function readWindowsProcessIdentityTableFresh(): Promise<WindowsProcessIdentityRow[]> {
  return readIdentityRows(true)
}

/** Whether the native table can be read at all on this host. */
export function isWindowsProcessTableAvailable(): boolean {
  return moduleLoader() !== null
}

/** PID-reuse protection requires the binary's creation-time capability: pnpm can patch the JS enum while retaining a prebuilt that ignores flag4. */
export function isWindowsProcessStartTimeAvailable(): boolean {
  const flags = moduleLoader()?.supportedProcessDataFlags ?? 0
  return (flags & PROCESS_DATA_FLAG.CreationTime) !== 0
}

/** Fresh identity for synchronous profile admission; opens one PID without taking a table snapshot. */
export function readWindowsProcessCreationTime(pid: number): number | null {
  if (process.platform !== 'win32' || !Number.isSafeInteger(pid) || pid <= 0 || pid > 0xffffffff) {
    return null
  }
  try {
    const value = moduleLoader()?.getProcessCreationTime?.(pid)
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
  } catch {
    return null
  }
}

function resetSnapshotReaders(): void {
  identityReader.reset()
  detailedReader.reset()
}

/** Inject the native loader: createRequire bypasses vi.mock and non-Windows installs may lack the module. */
export function __setWindowsProcessTreeLoaderForTests(
  loader?: () => WindowsProcessTreeModule | null
): void {
  moduleLoader = loader ?? loadWindowsProcessTree
  resetCachedModuleForTests()
  resetNativeReaderState()
  resetSnapshotReaders()
}

/** Inject resolution; attach resolve to exercise staged binary inspection. */
export function __setWindowsProcessTreeRequireForTests(resolve?: NativeRequire): void {
  setNativeRequireForTests(resolve)
  moduleLoader = loadWindowsProcessTree
  resetCachedModuleForTests()
  resetNativeReaderState()
  resetSnapshotReaders()
}

/** Inject CIM to avoid spawning PowerShell in tests. */
export function __setWindowsProcessTableCimScanForTests(
  scan?: () => Promise<WindowsProcessRow[]>
): void {
  cimScan = scan ?? readWindowsProcessRowsWithCim
  resetSnapshotReaders()
}

/** Test-only: drop the shared snapshots so suites cannot serve each other's rows. */
export function resetWindowsProcessTableForTests(): void {
  resetSnapshotReaders()
  resetCachedModuleForTests()
  resetNativeReaderState()
}
