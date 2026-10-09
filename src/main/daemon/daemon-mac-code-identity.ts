// Adapted from David Bebawy's PR #21826: `codesign --display +<pid>` is the probe that answers
// where a running pid's executable lives now. An unresolved image alone does not prove denial.

import { runProcess } from '../../shared/child-process/run-process'
import type { DaemonCodeIdentity } from '../../shared/daemon-adoption-telemetry'

const CODESIGN_TIMEOUT_MS = 3_000

// An unlinked executable prints no `Executable=` and exits 1 with this (Darwin 25.5). The exiting-
// pid error ('host has no guest') means the path did resolve, so it must not match.
const UNLINKED_EXECUTABLE_PATTERN = /No such file or directory/
// Squirrel parks the outgoing bundle under a `…ShipIt…` directory in $TMPDIR or ~/Library/Caches.
const PARKED_BUNDLE_PATTERN = /\/[^/]*ShipIt[^/]*\//

export type MacProcessCodeIdentity = {
  identity: DaemonCodeIdentity
  executablePath: string | null
}

function executablePathFromDisplay(output: string): string | null {
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith('Executable=')) {
      return line.slice('Executable='.length).trim() || null
    }
  }
  return null
}

export function classifyCodesignDisplayOutput(
  output: string,
  code: number | null
): DaemonCodeIdentity {
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith('Executable=')) {
      const executablePath = line.slice('Executable='.length).trim()
      if (executablePath.length > 0) {
        return PARKED_BUNDLE_PATTERN.test(executablePath) ? 'parked' : 'resolved'
      }
    }
  }
  return code !== 0 && UNLINKED_EXECUTABLE_PATTERN.test(output) ? 'unresolvable' : 'probe-failed'
}

async function probe(pid: number): Promise<MacProcessCodeIdentity> {
  try {
    const result = await runProcess({
      program: '/usr/bin/codesign',
      args: ['--display', '--verbose=1', `+${pid}`],
      timeoutMs: CODESIGN_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    // A killed codesign can still have printed a path; that half-written display proves nothing.
    if (result.timedOut) {
      return { identity: 'probe-failed', executablePath: null }
    }
    // codesign writes both the display fields and its diagnostics to stderr.
    const output = `${result.stderr}\n${result.stdout}`
    return {
      identity: classifyCodesignDisplayOutput(output, result.code),
      executablePath:
        result.code === 0 && !result.outputTruncated ? executablePathFromDisplay(output) : null
    }
  } catch {
    return { identity: 'probe-failed', executablePath: null }
  }
}

// Concurrent asks about one pid (a burst of spawns) share a probe; nothing outlives it.
let inFlight: { pid: number; pending: Promise<MacProcessCodeIdentity> } | null = null

/** Read fresh on every ask: a parked bundle can be deleted mid-run, flipping `parked` to `unresolvable`. */
export function inspectMacProcessCodeIdentity(
  pid: number | null | undefined
): Promise<MacProcessCodeIdentity> {
  if (process.platform !== 'darwin' || !pid || !Number.isSafeInteger(pid) || pid <= 0) {
    return Promise.resolve({ identity: 'probe-failed', executablePath: null })
  }
  if (inFlight?.pid !== pid) {
    const entry = { pid, pending: probe(pid) }
    inFlight = entry
    void entry.pending.then(() => {
      if (inFlight === entry) {
        inFlight = null
      }
    })
  }
  return inFlight.pending
}

export async function getDaemonMacCodeIdentity(
  pid: number | null | undefined
): Promise<DaemonCodeIdentity> {
  return (await inspectMacProcessCodeIdentity(pid)).identity
}
