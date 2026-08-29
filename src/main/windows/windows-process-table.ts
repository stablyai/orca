import { createRequire } from 'node:module'
import { performance } from 'node:perf_hooks'
import { createProcessTableSnapshotReader } from '../../shared/process-table-snapshot'

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
 * Measured on Windows 11 (1050 processes), p50 / p95:
 *   pid+ppid+name        15.9 / 17.5 ms
 *   +memory +commandLine 30.6 / 33.7 ms
 *   PowerShell CIM        706 / 723  ms
 */

export type WindowsProcessRow = {
  pid: number
  ppid: number
  name: string
  /** Full command line. Empty when the process denied a query handle. */
  command: string
  /** Working set in bytes, or undefined when not requested/queryable. */
  memoryBytes?: number
  /** Process creation time in Unix milliseconds, when the native snapshot provides it. */
  creationTimeMs?: number
  /** Committed private bytes, or undefined when not queryable. */
  privateMemoryBytes?: number
  /** Cumulative kernel + user time in 100 ns ticks. */
  cpuTimeTicks?: string
  /** Exact Windows process creation FILETIME, used to fence PID reuse. */
  startTimeId?: string
}

export type WindowsProcessTableSnapshot = {
  rows: WindowsProcessRow[]
  capturedAtMs: number
}

type NativeProcessInfo = {
  pid: number
  ppid: number
  name: string
  memory?: number
  privateMemory?: number
  cpuTimeTicks?: string
  startTimeId?: string
  commandLine?: string
  creationTimeMs?: number
}

type WindowsProcessTreeModule = {
  ProcessDataFlag: {
    None: number
    Memory: number
    CommandLine: number
    CreationTime?: number
  }
  getAllProcesses: (
    callback: (processes: NativeProcessInfo[] | undefined) => void,
    flags?: number
  ) => void
}

const requireFromMain = createRequire(__filename)

// Why injectable: `createRequire` bypasses the module mocker, and the two
// resolution steps below are the exact thing #15749 shipped untested -- the
// relay suites replaced the loader wholesale, so nothing exercised the require.
let requireNative: (specifier: string) => unknown = requireFromMain

/**
 * The bare addon a relay host receives, with no npm package around it.
 *
 * The published package's `lib/index.js` adds only a queue over this call, and
 * that queue is the wedge this module already defends against: it latches a
 * module-global `requestInProgress` with no try/catch. We hold our own
 * single-flight and deadline, so binding straight to the addon drops the
 * duplicate queue rather than nesting inside it.
 */
type WindowsProcessTreeAddon = {
  processTableContractVersion?: number
  getProcessList: (
    callback: (processes: NativeProcessInfo[] | undefined) => void,
    flags: number
  ) => void
}

/** Mirrors the package's enum; the addon takes the raw bit field. */
const PROCESS_DATA_FLAG = { None: 0, Memory: 1, CommandLine: 2, CreationTime: 4 } as const

/** Staged beside the relay bundle by build-relay; see RELAY_ARTIFACTS. */
const RELAY_ADDON_FILENAME = './windows-process-tree.node'
const PACKAGE_ADDON_SPECIFIER =
  '@vscode/windows-process-tree/build/Release/windows_process_tree.node'
const PROCESS_TABLE_CONTRACT_VERSION = 1

let cachedModule: WindowsProcessTreeModule | null | undefined
let moduleLoader: () => WindowsProcessTreeModule | null = loadWindowsProcessTree

/** Present the bare addon through the same shape as the npm package. */
function adaptAddon(addon: WindowsProcessTreeAddon): WindowsProcessTreeModule {
  return {
    ProcessDataFlag: PROCESS_DATA_FLAG,
    getAllProcesses: (callback, flags) => addon.getProcessList(callback, flags ?? 0)
  }
}

function hasCurrentProcessTableContract(addon: WindowsProcessTreeAddon): boolean {
  return (
    addon?.processTableContractVersion === PROCESS_TABLE_CONTRACT_VERSION &&
    typeof addon.getProcessList === 'function'
  )
}

/**
 * Resolve the native reader, or null where it cannot be used.
 *
 * Two sources, because two very different deployments need it. The desktop app
 * installs the npm package. A relay host has no node_modules of ours at all, so
 * build-relay stages the bare addon next to the bundle and we bind to that.
 *
 * Absence is unavailable evidence. It must never reactivate the recurring
 * PowerShell scan this native inventory exists to eliminate.
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
    const addon = requireNative(PACKAGE_ADDON_SPECIFIER) as WindowsProcessTreeAddon
    cachedModule = hasCurrentProcessTableContract(addon) ? adaptAddon(addon) : null
    if (!cachedModule) {
      return cachedModule
    }
    return cachedModule
  } catch {
    // Not an error here: the relay never has the package. Try the staged addon.
  }
  try {
    const addon = requireNative(RELAY_ADDON_FILENAME) as WindowsProcessTreeAddon
    // Why check the shape: a truncated upload or an addon built for another
    // arch can load and still not answer. Binding to it would then reject every
    // read forever, so treat it as unavailable evidence.
    cachedModule = hasCurrentProcessTableContract(addon)
      ? adaptAddon(addon)
      : /* v8 ignore next */ null
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
 */
const unreturnedReads = new Set<number>()
let readSequence = 0
let nativeReaderEpoch = 0

function resetNativeReaderState(): void {
  nativeReaderEpoch += 1
  unreturnedReads.clear()
}

const WINDOWS_TO_UNIX_EPOCH_TICKS = 116_444_736_000_000_000n

function fileTimeToUnixMs(startTimeId: string | undefined): number | undefined {
  if (!startTimeId || !/^\d+$/.test(startTimeId)) {
    return undefined
  }
  const ticks = BigInt(startTimeId)
  if (ticks < WINDOWS_TO_UNIX_EPOCH_TICKS) {
    return undefined
  }
  const milliseconds = Number((ticks - WINDOWS_TO_UNIX_EPOCH_TICKS) / 10_000n)
  return Number.isSafeInteger(milliseconds) ? milliseconds : undefined
}

function readNativeRows(): Promise<WindowsProcessTableSnapshot> {
  const native = moduleLoader()
  if (!native) {
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
  // Why always both flags: each adds an OpenProcess per process (Memory a
  // GetProcessMemoryInfo, CommandLine a PEB read), so asking for less would be
  // cheaper -- 15.9ms p50 versus 30.6ms at 1050 processes. But every read shares
  // one snapshot so a 32-wide teardown collapses into a single scan, and that
  // snapshot has to satisfy every caller. Splitting the cache per field set
  // would restore exactly the fan-out it exists to prevent.
  const flags =
    native.ProcessDataFlag.Memory |
    native.ProcessDataFlag.CommandLine |
    (native.ProcessDataFlag.CreationTime ?? 0)
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
        resolve({
          capturedAtMs: performance.now(),
          rows: processes.map((row) => {
            const creationTimeMs =
              typeof row.creationTimeMs === 'number'
                ? row.creationTimeMs
                : fileTimeToUnixMs(row.startTimeId)
            return {
              pid: row.pid,
              ppid: row.ppid,
              name: row.name,
              command: row.commandLine ?? '',
              memoryBytes: row.memory,
              ...(creationTimeMs === undefined ? {} : { creationTimeMs }),
              privateMemoryBytes: row.privateMemory,
              cpuTimeTicks: row.cpuTimeTicks,
              startTimeId: row.startTimeId
            }
          })
        })
      }, flags)
    } catch (error) {
      clearTimeout(deadline)
      reject(error instanceof Error ? error : new Error(String(error)))
    }
  })
}

// Why still cache: the snapshot is cheap but not free, and a worktree delete
// tears down PTYs 32-wide. The shared TTL + single-in-flight reader collapses
// that burst into one scan, exactly as the PowerShell path had to.
const snapshotReader = createProcessTableSnapshotReader<WindowsProcessTableSnapshot>({
  runPs: readNativeRows,
  now: () => Date.now()
})

/** Cached snapshot, refreshed on the shared TTL. */
export async function readWindowsProcessTable(): Promise<WindowsProcessRow[]> {
  return (await snapshotReader.getSnapshot()).rows
}

/** Cached snapshot plus the native capture time used for counter deltas. */
export function readWindowsProcessTableSnapshot(): Promise<WindowsProcessTableSnapshot> {
  return snapshotReader.getSnapshot()
}

/**
 * A snapshot taken after this call returns.
 *
 * Identity checks during teardown must not reuse a cached row — it can predate
 * the very process exit it is being asked about.
 */
export async function readWindowsProcessTableFresh(): Promise<WindowsProcessRow[]> {
  return (await snapshotReader.getFreshSnapshot()).rows
}

/** Whether the native table can be read at all on this host. */
export function isWindowsProcessTableAvailable(): boolean {
  return moduleLoader() !== null
}

/**
 * PID-reuse-safe ownership needs the native creation-time field, not merely a
 * process list. Older addon builds expose the table without that field; keep
 * structured ownership unavailable on those hosts instead of fabricating proof
 * from a PID.
 */
export function isWindowsProcessStartTimeAvailable(): boolean {
  const native = moduleLoader()
  return native !== null && typeof native.ProcessDataFlag.CreationTime === 'number'
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
  snapshotReader.reset()
}

/** Test-only: substitute the require that resolves the package and the addon. */
export function __setWindowsProcessTreeRequireForTests(
  resolve?: (specifier: string) => unknown
): void {
  requireNative = resolve ?? requireFromMain
  moduleLoader = loadWindowsProcessTree
  cachedModule = undefined
  resetNativeReaderState()
  snapshotReader.reset()
}

/** Test-only: drop the shared snapshot so suites cannot serve each other's rows. */
export function resetWindowsProcessTableForTests(): void {
  snapshotReader.reset()
  cachedModule = undefined
  resetNativeReaderState()
}
