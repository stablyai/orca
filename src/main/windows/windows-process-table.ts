import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createProcessTableSnapshotReader } from '../../shared/process-table-snapshot-reader'
import { reportWindowsCommandLineRecoveryHealth } from './windows-command-line-recovery-health'
import { readWindowsProcessRowsWithCim } from './windows-process-table-cim-scan'

/**
 * The only place Orca reads the Windows process table.
 *
 * Every previous reader forked `powershell.exe` to run a `Get-CimInstance
 * Win32_Process` scan (with a `wmic` fallback that Windows 11 24H2 has
 * removed). Seven of them existed, on independent cadences. That is why:
 *
 * - a PowerShell Transcription policy recorded ~289 GB across 1.4 million
 *   files, because a scan ran every ~2 seconds (#15209);
 * - a Group Policy or AV block turned a process query into "unavailable",
 *   which callers read as "no evidence", which is how a PTY tree survived its
 *   own teardown (#9045, #10475);
 * - the scan cost ~700 ms and ran per pane, so panes multiplied it (#15036).
 *
 * A Toolhelp32 snapshot answers the same question in ~16 ms with no child
 * process at all, so none of those failure modes have anywhere to live.
 *
 * Two flag sets, because only some callers need a command line, and exactly one
 * native read in flight at a time, because the vendored wrapper coalesces
 * differing flags -- see docs/reference/windows-process-enumeration.md.
 *
 * Measured on Windows 11 (492 processes), p50 / p95:
 *   identity  pid+ppid+name         6.3 / 7.0  ms   0 OpenProcess
 *   detailed  +commandLine         12.3 / 13.4 ms   1 OpenProcess/process
 *   (retired) +memory +commandLine 13.1 / 14.1 ms   2 OpenProcess/process
 *   PowerShell CIM                  706 / 723  ms
 *
 * Dropping Memory removed the second per-process handle: it took an
 * OpenProcess(...|VM_READ) it never read through. CommandLine's own read is no
 * longer a PEB walk either -- the patched addon asks the kernel.
 *
 * Both Toolhelp32 rows predate `CreationTime`, which both flag sets now also
 * ask for and which is unmeasured here: it costs one
 * OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION) plus GetProcessTimes per
 * process, so identity no longer opens nothing at all -- but that pair is far
 * cheaper than either handle the rows above measure.
 *
 * All Toolhelp32 rows assume the optional `windows-process-tree.node` addon.
 * The desktop bundles it; no released relay carries it, so on an SSH host the
 * CIM row is the operative number and the child process is not avoided at all.
 */

/** Everything a Toolhelp32 walk alone can answer. */
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
  /**
   * Flag bits the COMPILED addon reports, straight from `addon.cc`. Absent on a
   * build that predates the patch — which is not the same question as the enum
   * above, because pnpm patches the source tree and leaves the tarball's
   * prebuilt `.node` in place.
   */
  supportedProcessDataFlags?: number
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

// Why injectable: `createRequire` bypasses the module mocker, and the two
// resolution steps below are the exact thing #15749 shipped untested -- the
// relay suites replaced the loader wholesale, so nothing exercised the require.
let requireNative: NativeRequire = requireFromMain

/**
 * The bare addon a relay host receives, with no npm package around it.
 *
 * The published package's `lib/index.js` adds only a queue over this call, and
 * that queue is the wedge this module already defends against: it latches a
 * module-global `requestInProgress` with no try/catch. `nativeReadGate` holds
 * the mutual exclusion instead -- and must, because this addon has no queue of
 * its own and two simultaneous `CreateToolhelp32Snapshot` calls are the crash
 * the vendor's queue exists to prevent. With one native call ever outstanding,
 * binding straight to the addon drops a duplicate rather than losing a guard.
 */
type WindowsProcessTreeAddon = {
  getProcessList: (
    callback: (processes: NativeProcessInfo[] | undefined) => void,
    flags: number
  ) => void
  supportedProcessDataFlags?: number
}

/**
 * Mirrors the package's enum; the addon takes the raw bit field. `Memory` (1)
 * is listed for completeness and is deliberately never set — see the projections
 * below.
 *
 * Naming `CreationTime` here only decides what we ASK for; whether the binary
 * answers is `supportedProcessDataFlags`, which the addon reports itself.
 */
const PROCESS_DATA_FLAG = { None: 0, Memory: 1, CommandLine: 2, CreationTime: 4 } as const

/** Staged beside the relay bundle by build-relay; see RELAY_ARTIFACTS. */
const RELAY_ADDON_FILENAME = './windows-process-tree.node'

/** The import whose absence tells the patched binary from the published prebuilt. */
const FLAGGED_ADDON_IMPORT = 'ReadProcessMemory'

/**
 * Refuse a staged relay addon built from unpatched source.
 *
 * The build asserts this on the artifact it produces, but a relay bundle and the
 * addon beside it are redeployed independently: a host that has not taken a new
 * bundle keeps whatever `.node` is already there, and the published prebuilt is
 * node-addon-api, so it binds cleanly and then opens every process with
 * `PROCESS_VM_READ` to walk its PEB -- the primitive MDE scores as credential
 * dumping. Nothing checked that at load until here.
 *
 * Same predicate as `inspectWindowsProcessTreeAddon` in
 * `config/scripts/windows-process-tree-gyp-rebuild.mjs`, which cannot be
 * imported here: it is install-time tooling that pulls in node-gyp and
 * `child_process`, and this module is bundled into the app and the relay.
 *
 * Falling back to the CIM scan is the correct loss: it is slower, and it is not
 * the thing an EDR quarantines the host for.
 */
function stagedRelayAddonIsUnpatched(): boolean {
  // No resolver means an injected test double, so there is no file to inspect.
  // Production always has one, and a require that just succeeded proves the
  // path is readable -- "cannot tell" here is never a real deployment.
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

let cachedModule: WindowsProcessTreeModule | null | undefined
let moduleLoader: () => WindowsProcessTreeModule | null = loadWindowsProcessTree
let cimScan: () => Promise<WindowsProcessRow[]> = readWindowsProcessRowsWithCim

/** Present the bare addon through the same shape as the npm package. */
function adaptAddon(addon: WindowsProcessTreeAddon): WindowsProcessTreeModule {
  return {
    ProcessDataFlag: PROCESS_DATA_FLAG,
    supportedProcessDataFlags: addon.supportedProcessDataFlags,
    getAllProcesses: (callback, flags) => addon.getProcessList(callback, flags ?? 0)
  }
}

/**
 * Resolve the native reader, or null where it cannot be used.
 *
 * Two sources, because two very different deployments need it. The desktop app
 * installs the npm package. A relay host has no node_modules of ours at all, so
 * build-relay stages the bare addon next to the bundle and we bind to that.
 *
 * Why tolerate absence: it stays optional and Windows-only, so a macOS/Linux
 * install legitimately has no binary, and a relay built before this artifact
 * existed has no file. Callers must treat null the same way they treat any
 * other unavailable evidence -- `readNativeRows` then falls back to the CIM
 * scan, which needs nothing installed.
 */
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
    // Not an error here: the relay never has the package. Try the staged addon.
  }
  try {
    const addon = requireNative(RELAY_ADDON_FILENAME) as WindowsProcessTreeAddon
    // Why check the shape: a truncated upload or an addon built for another
    // arch can load and still not answer. Binding to it would then reject every
    // read forever, where falling through reaches a scan that works.
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

/**
 * Upper bound on one snapshot.
 *
 * Why any bound at all: the vendored reader sets a module-global
 * `requestInProgress` and clears it only after draining its callback queue,
 * with no try/catch. One throw or one worker that never calls back leaves it
 * latched, every later call enqueues a callback that never fires, and the
 * single-flight cache above then holds a promise that never settles — the
 * process table is dead for the life of the app. The PowerShell reader this
 * replaced self-healed in 3s because execFile owned a timeout; keep that.
 */
const WINDOWS_PROCESS_QUERY_TIMEOUT_MS = 3_000

/**
 * Reads that missed their deadline and have not called back yet.
 * Refusing re-entry bounds both vendored callbacks and relay addon workers to
 * one; read ids keep a late callback from clearing a newer wedge.
 *
 * One gate for both flag sets, not one each: they call the same addon, so a
 * wedged read latches the one `requestInProgress` and pins the one libuv slot
 * whichever flags asked for it. Retention stays at exactly one callback rather
 * than one per reader because `nativeReadGate` below already admits only one
 * native call at a time; read ids are module-global and monotonic, so a late
 * callback can only clear its own wedge.
 */
const unreturnedReads = new Set<number>()
let readSequence = 0
let nativeReaderEpoch = 0

/**
 * Admits one native read at a time, across both flag sets. Nothing else does.
 *
 * The npm wrapper coalesces rather than queues: `getRawProcessList` pushes the
 * callback onto one list and only calls the addon when no request is in
 * progress, so a second concurrent caller's `flags` are DISCARDED and it is
 * handed the first caller's rows. An identity read racing a detailed read
 * therefore returns a table with every command line EMPTY, which agent
 * recognition reads as "no agent" -- silently, and only under concurrency.
 * Measured against the real addon: identity issued first, both callers got the
 * same array, 0 of 541 rows with a command line.
 *
 * Nothing above stops that. Each cache single-flights only within itself
 * (`inFlight` is a closure per reader) and the wedge set latches only after a
 * read misses its 3s deadline, so through the healthy ~12ms of a scan neither
 * excludes the other. Overlap is the normal state, not an edge case: panes poll
 * detailed every 750ms while a teardown takes identity snapshots.
 *
 * It also has to be here for the relay's bare addon, which has no queue at all:
 * two simultaneous `CreateToolhelp32Snapshot` calls are the crash the vendor's
 * queue exists to prevent.
 *
 * Every link settles -- a wedged read still rejects on its deadline -- so a
 * waiter is never stranded; it re-checks the wedge and rejects instead.
 */
let nativeReadGate: Promise<unknown> = Promise.resolve()

function resetNativeReaderState(): void {
  nativeReaderEpoch += 1
  unreturnedReads.clear()
  // Chain, never replace. Dropping the old chain lets a waiter still holding it
  // run against a read queued on the new one -- two concurrent calls into one
  // mock addon, which is precisely the coalescing these suites exist to catch.
  // Every link settles within the deadline, so the wait this costs is bounded.
  nativeReadGate = nativeReadGate.then(ignoreSettlement, ignoreSettlement)
}

/** A flag set and the row shape it can honestly produce. */
type ProcessRowProjection<Row> = {
  flags: (native: WindowsProcessTreeModule) => number
  fromNative: (row: NativeProcessInfo) => Row
  /**
   * The no-binding scan, on the one flag set it can serve. Absent on the other,
   * because a relay must never run two `Get-CimInstance` scans at ~1.4s each --
   * `readWindowsProcessIdentityTable` projects the detailed snapshot instead.
   */
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

/**
 * Toolhelp32 and nothing else: no `OpenProcess` per process, so this read has
 * none of the shape an EDR scores as walking another process's memory.
 */
const IDENTITY_PROJECTION: ProcessRowProjection<WindowsProcessIdentityRow> = {
  flags: (native) => native.ProcessDataFlag.None | (native.ProcessDataFlag.CreationTime ?? 0),
  fromNative: toIdentityRow
}

/**
 * Adds, per process, one `OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION)` and an
 * `NtQueryInformationProcess(ProcessCommandLineInformation)` -- which is what
 * agent recognition and port attribution match on. `Memory` is deliberately
 * absent: it took a second handle carrying `PROCESS_VM_READ` and then never read
 * through it, and no caller reads a working set off this table (the Resource
 * Manager runs its own sweep, and the native field wraps above 4 GB anyway).
 */
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
      // Why only when the module is absent: a binding that loads is the fast
      // path even when a read fails or wedges, so a failing native reader must
      // never silently start forking shells at the caller's poll rate. Absence
      // is the one condition that can never resolve itself — see
      // docs/reference/windows-process-enumeration.md.
      return projection.cimFallback()
    }
    // Reject rather than resolve empty: an empty table is a claim that nothing
    // is running, and callers act on that by force-killing or by declaring a
    // tree dead. "Unavailable" has to stay distinguishable from "empty".
    return Promise.reject(new Error('windows process table unavailable'))
  }
  if (unreturnedReads.size > 0) {
    return Promise.reject(
      new Error('windows process table is wedged: an earlier read has not returned')
    )
  }
  const readId = ++readSequence
  const readerEpoch = nativeReaderEpoch
  const flags = projection.flags(native)
  return new Promise((resolve, reject) => {
    // Hoisted so a synchronous throw from getAllProcesses can clear it. An
    // orphaned timer would otherwise fire later and wedge a reader that had
    // already recovered.
    let deadline: ReturnType<typeof setTimeout> | undefined
    try {
      deadline = setTimeout(() => {
        // Test resets invalidate deadlines owned by the prior injected reader.
        if (readerEpoch === nativeReaderEpoch) {
          unreturnedReads.add(readId)
        }
        reject(new Error('windows process table timed out'))
      }, WINDOWS_PROCESS_QUERY_TIMEOUT_MS)
      deadline.unref?.()
      native.getAllProcesses((processes) => {
        clearTimeout(deadline)
        // A callback proves this read drained, so stop refusing. Unconditional:
        // dropping an id that was never added is a no-op, and only the read
        // that actually wedged can be holding the gate shut.
        unreturnedReads.delete(readId)
        if (!processes) {
          reject(new Error('windows process table returned no snapshot'))
          return
        }
        // Why check for ourselves: the native snapshot returns an EMPTY list --
        // not an error -- when CreateToolhelp32Snapshot fails, which is the
        // normal outcome under an EDR hook or a restricted token. An empty
        // table reads to callers as "nothing is running", and teardown acts on
        // that by concluding a live PTY root is already gone. Our own pid is
        // unfalsifiably present in any honest snapshot, so this one predicate
        // catches empty, truncated and permission-filtered tables alike.
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

/**
 * Whole-table read for hosts with no native binding (the relay).
 *
 * Applies the same self-presence guard as the native path: a scan that omits
 * our own pid is truncated or permission-filtered, not empty, and must reject
 * so nothing downstream reads it as proof a process died.
 */
async function readCimRows(): Promise<WindowsProcessRow[]> {
  const rows = await cimScan()
  if (!rows.some((row) => row.pid === process.pid)) {
    throw new Error('windows process table is unreadable')
  }
  return rows
}

// Why still cache: the snapshot is cheap but not free, and a worktree delete
// tears down PTYs 32-wide. The shared TTL + single-in-flight reader collapses
// that burst into one scan, exactly as the PowerShell path had to.
//
// Why two caches are safe where N would not be: the fan-out this prevents is
// one scan per *caller*, and each reader below still serves every caller that
// wants its flag set, so a 32-wide teardown collapses into one scan per flag
// set. Two is the number of distinct native calls that exist -- a third cache
// would need a third flag set, never a third caller.
const identityReader = createProcessTableSnapshotReader<WindowsProcessIdentityRow[]>({
  runPs: () => readNativeRows(IDENTITY_PROJECTION),
  now: () => Date.now()
})
const detailedReader = createProcessTableSnapshotReader<WindowsProcessRow[]>({
  runPs: () => readNativeRows(DETAILED_PROJECTION),
  now: () => Date.now()
})

/**
 * With no binding there is only one scan to run and it is the expensive one, so
 * the identity view rides the detailed snapshot rather than forking a second
 * `powershell.exe` at ~1.4 s a scan. Projected, not merely widened: an identity
 * row must not carry a command line on any host.
 */
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

/**
 * A snapshot taken after this call returns.
 *
 * Identity checks during teardown must not reuse a cached row — it can predate
 * the very process exit it is being asked about.
 */
export function readWindowsProcessTableFresh(): Promise<WindowsProcessRow[]> {
  return detailedReader.getFreshSnapshot()
}

/** Cached pid/ppid/name snapshot. Prefer this whenever no command line is read. */
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

/**
 * PID-reuse-safe ownership needs the native creation-time field, not merely a
 * process list.
 *
 * Why the binary's own answer and not the enum: pnpm patches the package's
 * source tree but leaves the tarball's prebuilt `.node` at the same
 * `build/Release/` path, so a host can hold a patched `lib/index.js` — enum and
 * all — over a binary that ignores flag 4. CI produced exactly that: the enum
 * said available, and every row came back without `creationTimeMs`. Answering
 * true there is worse than answering false: the descendant snapshot then
 * returns null forever and the exit proof latches `unverifiable`, while
 * structured chat believes it has a reaper.
 */
export function isWindowsProcessStartTimeAvailable(): boolean {
  const native = moduleLoader()
  return (
    native !== null &&
    ((native.supportedProcessDataFlags ?? 0) & PROCESS_DATA_FLAG.CreationTime) !== 0
  )
}

function resetSnapshotReaders(): void {
  identityReader.reset()
  detailedReader.reset()
}

/**
 * Test-only: substitute the native module.
 *
 * Why an injector and not `vi.mock`: the module is resolved through
 * `createRequire` so a macOS/Linux install can legitimately not have it, and
 * `createRequire` bypasses the module mocker.
 */
export function __setWindowsProcessTreeLoaderForTests(
  loader?: () => WindowsProcessTreeModule | null
): void {
  moduleLoader = loader ?? loadWindowsProcessTree
  cachedModule = undefined
  resetNativeReaderState()
  resetSnapshotReaders()
}

/**
 * Test-only: substitute the require that resolves the package and the addon.
 *
 * Attach a `resolve` to the injected function to also exercise the staged-addon
 * binary check; without one, the loader has no path to inspect.
 */
export function __setWindowsProcessTreeRequireForTests(resolve?: NativeRequire): void {
  requireNative = resolve ?? requireFromMain
  moduleLoader = loadWindowsProcessTree
  cachedModule = undefined
  resetNativeReaderState()
  resetSnapshotReaders()
}

/** Test-only: substitute the no-binding PowerShell scan, which spawns a child. */
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
