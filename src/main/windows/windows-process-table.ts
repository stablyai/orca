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

function readNativeRows(): Promise<WindowsProcessRow[]> {
  const native = moduleLoader()
  if (!native) {
    // Reject rather than resolve empty: an empty table is a claim that nothing
    // is running, and callers act on that by force-killing or by declaring a
    // tree dead. "Unavailable" has to stay distinguishable from "empty".
    return Promise.reject(new Error('windows process table unavailable'))
  }
  const flags = native.ProcessDataFlag.Memory | native.ProcessDataFlag.CommandLine
  return new Promise((resolve, reject) => {
    try {
      native.getAllProcesses((processes) => {
        if (!processes) {
          reject(new Error('windows process table returned no snapshot'))
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
  snapshotReader.reset()
}

/** Test-only: drop the shared snapshot so suites cannot serve each other's rows. */
export function resetWindowsProcessTableForTests(): void {
  snapshotReader.reset()
  cachedModule = undefined
}
