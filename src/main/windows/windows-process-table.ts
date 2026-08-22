import { createRequire } from 'node:module'
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
}

type NativeProcessInfo = {
  pid: number
  ppid: number
  name: string
  memory?: number
  commandLine?: string
}

type WindowsProcessTreeModule = {
  ProcessDataFlag: { None: number; Memory: number; CommandLine: number }
  getAllProcesses: (
    callback: (processes: NativeProcessInfo[] | undefined) => void,
    flags?: number
  ) => void
}

const requireFromMain = createRequire(__filename)

let cachedModule: WindowsProcessTreeModule | null | undefined
let moduleLoader: () => WindowsProcessTreeModule | null = loadWindowsProcessTree

/**
 * Resolve the native module, or null where it cannot be used.
 *
 * Why tolerate absence: it is an optional, Windows-only dependency, so a
 * macOS/Linux install legitimately has no binary. Callers must treat null the
 * same way they treat any other unavailable evidence.
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
    cachedModule = requireFromMain('@vscode/windows-process-tree') as WindowsProcessTreeModule
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
 * How long to stop calling the reader after it misses its deadline.
 *
 * Why a cooldown and not just the deadline: a timed-out call leaves its
 * callback in the vendored module's queue, and that queue only drains when the
 * latched request finally completes -- which, in the wedge this guards against,
 * never happens. Retrying at the caller's poll rate would then add a closure
 * per tick forever. One probe per cooldown bounds it.
 */
const WINDOWS_PROCESS_QUERY_COOLDOWN_MS = 30_000

let wedgedUntilMs = 0
// Why a generation: a request that already lost its deadline must not later
// clear or re-arm the wedge on behalf of the request that replaced it.
let readGeneration = 0

function readNativeRows(): Promise<WindowsProcessRow[]> {
  const native = moduleLoader()
  if (!native) {
    // Reject rather than resolve empty: an empty table is a claim that nothing
    // is running, and callers act on that by force-killing or by declaring a
    // tree dead. "Unavailable" has to stay distinguishable from "empty".
    return Promise.reject(new Error('windows process table unavailable'))
  }
  const startedAt = Date.now()
  if (startedAt < wedgedUntilMs) {
    return Promise.reject(new Error('windows process table is cooling down after a timeout'))
  }
  if (wedgedUntilMs > 0) {
    // Coming out of a wedge: re-arm the cooldown BEFORE probing, so exactly one
    // caller gets through. Without this every concurrent caller passes the
    // check above at expiry, each enqueues a callback into the still-latched
    // native queue, and each cooldown cycle leaks another batch rather than
    // bounding it to one probe.
    wedgedUntilMs = startedAt + WINDOWS_PROCESS_QUERY_COOLDOWN_MS
  }
  const generation = ++readGeneration
  // Why always both flags: each adds an OpenProcess per process (Memory a
  // GetProcessMemoryInfo, CommandLine a PEB read), so asking for less would be
  // cheaper -- 15.9ms p50 versus 30.6ms at 1050 processes. But every read shares
  // one snapshot so a 32-wide teardown collapses into a single scan, and that
  // snapshot has to satisfy every caller. Splitting the cache per field set
  // would restore exactly the fan-out it exists to prevent.
  const flags = native.ProcessDataFlag.Memory | native.ProcessDataFlag.CommandLine
  return new Promise((resolve, reject) => {
    // Hoisted so a synchronous throw from getAllProcesses can clear it. An
    // orphaned timer would otherwise fire later and wedge a reader that had
    // already recovered.
    let deadline: ReturnType<typeof setTimeout> | undefined
    try {
      deadline = setTimeout(() => {
        if (generation === readGeneration) {
          wedgedUntilMs = Date.now() + WINDOWS_PROCESS_QUERY_COOLDOWN_MS
        }
        reject(new Error('windows process table timed out'))
      }, WINDOWS_PROCESS_QUERY_TIMEOUT_MS)
      deadline.unref?.()
      native.getAllProcesses((processes) => {
        clearTimeout(deadline)
        // A callback proves the reader is answering, so stop refusing.
        if (generation === readGeneration) {
          wedgedUntilMs = 0
        }
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
        resolve(
          processes.map((row) => ({
            pid: row.pid,
            ppid: row.ppid,
            name: row.name,
            command: row.commandLine ?? '',
            memoryBytes: row.memory
          }))
        )
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
const snapshotReader = createProcessTableSnapshotReader<WindowsProcessRow[]>({
  runPs: readNativeRows,
  now: () => Date.now()
})

/** Cached snapshot, refreshed on the shared TTL. */
export function readWindowsProcessTable(): Promise<WindowsProcessRow[]> {
  return snapshotReader.getSnapshot()
}

/**
 * A snapshot taken after this call returns.
 *
 * Identity checks during teardown must not reuse a cached row — it can predate
 * the very process exit it is being asked about.
 */
export function readWindowsProcessTableFresh(): Promise<WindowsProcessRow[]> {
  return snapshotReader.getFreshSnapshot()
}

/** Whether the native table can be read at all on this host. */
export function isWindowsProcessTableAvailable(): boolean {
  return moduleLoader() !== null
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
  wedgedUntilMs = 0
  snapshotReader.reset()
}

/** Test-only: drop the shared snapshot so suites cannot serve each other's rows. */
export function resetWindowsProcessTableForTests(): void {
  snapshotReader.reset()
  cachedModule = undefined
  wedgedUntilMs = 0
}
