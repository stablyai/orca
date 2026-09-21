import { runProcess } from '../../shared/child-process/run-process'

/**
 * What macOS itself can still say about a running process's code.
 *
 * 'resolved': the kernel maps the pid to on-disk code at `executablePath` (the path the
 * executable lives at NOW, so a bundle Squirrel parked under $TMPDIR shows up there).
 * 'unresolvable': the pid is alive but its executable was unlinked. This is the exact state in
 * which tccd can no longer resolve the daemon's code identity and denies its terminals
 * TCC folders and Local Network (#20007).
 * 'unavailable': the probe itself failed (no codesign, timeout, pid gone). Fails open.
 */
export type MacProcessCodeIdentity =
  | { status: 'resolved'; executablePath: string }
  | { status: 'unresolvable' }
  | { status: 'unavailable' }

export type MacCodeIdentityCommandRunner = (
  program: string,
  args: readonly string[],
  timeoutMs: number
) => Promise<{ code: number | null; stderr: string; stdout: string }>

const CODESIGN_PATH = '/usr/bin/codesign'
const CODESIGN_TIMEOUT_MS = 3_000

// Only ENOENT: on --display the guest lookup fails at proc_pidpath when the executable is
// unlinked. errSecCSNoSuchCode ('host has no guest') means proc_pidpath resolved but the pid is
// exiting - it is what --verify reports for a severed daemon, and here it is not evidence.
const UNLINKED_EXECUTABLE_PATTERN = /No such file or directory/

const defaultRunner: MacCodeIdentityCommandRunner = (program, args, timeoutMs) =>
  runProcess({ program, args, timeoutMs, stdio: ['ignore', 'pipe', 'pipe'] })

export function parseCodesignDisplayOutput(
  output: string,
  code: number | null
): MacProcessCodeIdentity {
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith('Executable=')) {
      const executablePath = line.slice('Executable='.length).trim()
      if (executablePath.length > 0) {
        return { status: 'resolved', executablePath }
      }
    }
  }
  if (code !== 0 && UNLINKED_EXECUTABLE_PATTERN.test(output)) {
    return { status: 'unresolvable' }
  }
  return { status: 'unavailable' }
}

/**
 * Ask Security.framework (via `codesign -d +<pid>`) where a live process's code is. Node has no
 * proc_pidpath; `ps -o comm=` echoes argv[0] as spawned, which still names the old bundle path
 * after Squirrel renames it — only the kernel's view answers "where is this executable now".
 */
export async function inspectMacProcessCodeIdentity(
  pid: number,
  runCommand: MacCodeIdentityCommandRunner = defaultRunner
): Promise<MacProcessCodeIdentity> {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return { status: 'unavailable' }
  }
  try {
    const result = await runCommand(
      CODESIGN_PATH,
      ['--display', '--verbose=1', `+${pid}`],
      CODESIGN_TIMEOUT_MS
    )
    // codesign writes both the display fields and its diagnostics to stderr.
    return parseCodesignDisplayOutput(`${result.stderr}\n${result.stdout}`, result.code)
  } catch {
    return { status: 'unavailable' }
  }
}
