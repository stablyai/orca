import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createProcessTableSnapshotReader } from '../../shared/process-table-snapshot-reader'
import { ORCAD_WINDOWS_PROCESS_TREE_FILENAME } from '../../shared/orcad-artifacts'
import { reportWindowsCommandLineRecoveryHealth } from './windows-command-line-recovery-health'
import { readWindowsProcessRowsWithCim } from './windows-process-table-cim-scan'
import { WindowsProcessTableTimeoutError } from './windows-process-table-timeout-error'

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

type NativeProcessInfo = {
  pid: number
  ppid: number
  name: string
  commandLine?: string
  creationTimeMs?: number
}

type WindowsProcessTreeModule = {
  ProcessDataFlag: {
    None: number
    CommandLine: number
    CreationTime?: number
  }
  /** Compiled addon capabilities; patched JS enums may sit above an older prebuilt binary. */
  supportedProcessDataFlags?: number
  getProcessCreationTime?: (pid: number) => number | undefined
  getAllProcesses: (
    callback: (processes: NativeProcessInfo[] | undefined) => void,
    flags?: number
  ) => void
}

const requireFromMain = createRequire(__filename)

/** `resolve` is optional so a test can inject a bare function for the require alone. */
type NativeRequire = ((specifier: string) => unknown) & {
  resolve?: (specifier: string) => string
}

// createRequire bypasses vi.mock; inject actual resolution so relay specifiers are tested.
let requireNative: NativeRequire = requireFromMain

/** Bare relay addon has no queue; nativeReadGate must serialize it to prevent concurrent native snapshots. The npm wrapper adds its own coalescing queue. */
type WindowsProcessTreeAddon = {
  getProcessCreationTime?: (pid: number) => number | undefined
  getProcessList: (
    callback: (processes: NativeProcessInfo[] | undefined) => void,
    flags: number
  ) => void
  supportedProcessDataFlags?: number
}

/** Raw addon flags; Memory stays off. CreationTime in this enum requests it but only supportedProcessDataFlags proves binary support. */
const PROCESS_DATA_FLAG = { None: 0, Memory: 1, CommandLine: 2, CreationTime: 4 } as const

/** Staged beside the orcad bundle by orcad-windows-process-tree.mjs. */
const RELAY_ADDON_FILENAME = `./${ORCAD_WINDOWS_PROCESS_TREE_FILENAME}`

/** The import whose absence tells the patched binary from the published prebuilt. */
const FLAGGED_ADDON_IMPORT = 'ReadProcessMemory'

/** Reject staged addons importing ReadProcessMemory: independently deployed old binaries can load yet restore EDR-flagged PEB reads. Match the build inspector without importing its node-gyp/child_process dependencies; fall back to CIM. */
function stagedRelayAddonIsUnpatched(): boolean {
  // Missing resolver denotes a test double; production resolves the binary it just loaded.
  const addonPath = requireNative.resolve?.(RELAY_ADDON_FILENAME)
  if (!addonPath) {
    return false
  }
  try {
    return readFileSync(addonPath).includes(FLAGGED_ADDON_IMPORT)
  } catch {
    return false
  }
}

/** Warn once where stderr survives; daemon startup reports capability through daemonLog instead. */
let warnedAboutCimFallback = false

let cachedModule: WindowsProcessTreeModule | null | undefined
let moduleLoader: () => WindowsProcessTreeModule | null = loadWindowsProcessTree
let cimScan: () => Promise<WindowsProcessRow[]> = readWindowsProcessRowsWithCim

/** Present the bare addon through the same shape as the npm package. */
function adaptAddon(addon: WindowsProcessTreeAddon): WindowsProcessTreeModule {
  return {
    ProcessDataFlag: PROCESS_DATA_FLAG,
    supportedProcessDataFlags: addon.supportedProcessDataFlags,
    getProcessCreationTime: addon.getProcessCreationTime,
    getAllProcesses: (callback, flags) => addon.getProcessList(callback, flags ?? 0)
  }
}

/** Load the desktop npm package or staged bare relay addon. Both remain optional across platforms/older deployments; null selects CIM on Windows and remains unavailable elsewhere. */
function loadWindowsProcessTree(): WindowsProcessTreeModule | null {
  if (cachedModule !== undefined) {
    return cachedModule
  }
  if (process.platform !== 'win32') {
    cachedModule = null
    return cachedModule
  }
  try {
    cachedModule = requireNative('@vscode/windows-process-tree') as WindowsProcessTreeModule
    return cachedModule
  } catch {
    // Relays lack the npm package; try their staged addon.
  }
  try {
    const addon = requireNative(RELAY_ADDON_FILENAME) as WindowsProcessTreeAddon
    // Reject unusable shapes so an invalid addon can fall back to CIM.
    if (typeof addon?.getProcessList !== 'function') {
      /* v8 ignore next 2 */
      cachedModule = null
      return cachedModule
    }
    if (stagedRelayAddonIsUnpatched()) {
      console.warn(
        `[windows-process-table] the addon staged beside the relay bundle still imports ` +
          `${FLAGGED_ADDON_IMPORT}, so it was built from unpatched source and reads every ` +
          'process address space. Refusing it and falling back to the CIM scan; redeploy the ' +
          'relay so the staged addon is rebuilt.'
      )
      cachedModule = null
      return cachedModule
    }
    cachedModule = adaptAddon(addon)
  } catch {
    cachedModule = null
  }
  return cachedModule
}

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

// TTL/single-flight caches collapse teardown bursts into at most one scan per flag set.
const identityReader = createProcessTableSnapshotReader<WindowsProcessIdentityRow[]>({
  runPs: () => readNativeRows(IDENTITY_PROJECTION),
  now: () => Date.now()
})
const detailedReader = createProcessTableSnapshotReader<WindowsProcessRow[]>({
  runPs: () => readNativeRows(DETAILED_PROJECTION),
  now: () => Date.now()
})

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
  const native = moduleLoader()
  return (
    native !== null &&
    ((native.supportedProcessDataFlags ?? 0) & PROCESS_DATA_FLAG.CreationTime) !== 0
  )
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
  cachedModule = undefined
  resetNativeReaderState()
  resetSnapshotReaders()
}

/** Inject resolution; attach resolve to exercise staged binary inspection. */
export function __setWindowsProcessTreeRequireForTests(resolve?: NativeRequire): void {
  requireNative = resolve ?? requireFromMain
  moduleLoader = loadWindowsProcessTree
  cachedModule = undefined
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
  cachedModule = undefined
  resetNativeReaderState()
}
