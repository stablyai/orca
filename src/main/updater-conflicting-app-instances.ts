import { execFile } from 'node:child_process'

// Why: Squirrel.Mac's ShipIt waits for EVERY running instance of the target
// bundle (NSRunningApplication matched by bundle id + bundle URL) to exit
// before it installs, and aborts with "App Still Running Error" if one
// appears mid-install. A second packaged Orca — a manually opened copy or an
// agent/e2e rig launching /Applications/Orca.app with a temp profile, often
// windowless and invisible — silently stalls the update forever while the
// user sees "app quit but never relaunched, still on the old version".
// Detecting those instances before the install handoff turns that silent
// wedge into an actionable message.
const RUNNING_APPLICATION_QUERY_TIMEOUT_MS = 2_000
const RUNNING_APPLICATION_QUERY_MAX_BYTES = 64 * 1024

// Why: Squirrel identifies blockers as NSRunningApplication instances by
// bundle identity. An exact-executable `ps` scan also catches Orca CLI
// processes running through ELECTRON_RUN_AS_NODE, even though AppKit gives
// those processes no bundle id or URL and Squirrel does not wait for them.
const RUNNING_APPLICATION_QUERY = String.raw`
function run(argv) {
  ObjC.import('AppKit')
  const executablePath = argv[0]
  const currentPid = Number(argv[1])
  const applications = $.NSWorkspace.sharedWorkspace.runningApplications
  const pids = []
  for (let index = 0; index < applications.count; index += 1) {
    const application = applications.objectAtIndex(index)
    const executableUrl = application.executableURL
    const bundleIdentifier = application.bundleIdentifier
    const pid = Number(application.processIdentifier)
    if (
      executableUrl &&
      bundleIdentifier &&
      String(ObjC.unwrap(executableUrl.path)) === executablePath &&
      pid !== currentPid
    ) {
      pids.push(String(pid))
    }
  }
  return pids.join('\n')
}`

export type RunningApplicationPidReader = (
  executablePath: string,
  currentPid: number
) => Promise<string>

function readCurrentUserRunningApplicationPids(
  executablePath: string,
  currentPid: number
): Promise<string> {
  return new Promise((resolve, reject) => {
    // Why: query AppKit in one bounded subprocess instead of launching a probe
    // per candidate. Passing paths as argv avoids script interpolation, and
    // osascript needs no Accessibility permission for NSWorkspace metadata.
    execFile(
      '/usr/bin/osascript',
      [
        '-l',
        'JavaScript',
        '-e',
        RUNNING_APPLICATION_QUERY,
        '--',
        executablePath,
        String(currentPid)
      ],
      {
        encoding: 'utf8',
        timeout: RUNNING_APPLICATION_QUERY_TIMEOUT_MS,
        maxBuffer: RUNNING_APPLICATION_QUERY_MAX_BYTES
      },
      (error, stdout) => {
        if (error) {
          reject(error)
          return
        }
        resolve(stdout)
      }
    )
  })
}

export function parseRunningApplicationPids(output: string, currentPid: number): number[] {
  const pids: number[] = []
  for (const line of output.split('\n')) {
    const normalized = line.trim()
    if (!/^\d+$/.test(normalized)) {
      continue
    }
    const pid = Number(normalized)
    if (pid > 0 && pid !== currentPid) {
      pids.push(pid)
    }
  }
  return pids
}

export type ConflictingInstanceDeps = {
  platform?: NodeJS.Platform
  executablePath?: string
  currentPid?: number
  readRunningApplicationPids?: RunningApplicationPidReader
}

/**
 * Pids of other running app instances launched from this same executable.
 *
 * macOS-only by design: this mirrors Squirrel.Mac's pre-install wait/abort
 * semantics. The Windows and Linux installers manage running instances
 * themselves. Fails open — an unavailable application query must never block
 * an update install.
 */
export async function findConflictingAppInstancePids(
  deps: ConflictingInstanceDeps = {}
): Promise<number[]> {
  if ((deps.platform ?? process.platform) !== 'darwin') {
    return []
  }
  const executablePath = deps.executablePath ?? process.execPath
  const currentPid = deps.currentPid ?? process.pid
  try {
    const output = await (deps.readRunningApplicationPids ?? readCurrentUserRunningApplicationPids)(
      executablePath,
      currentPid
    )
    return parseRunningApplicationPids(output, currentPid)
  } catch {
    return []
  }
}
