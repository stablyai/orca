// Adapted from David Bebawy's PR #21826: `codesign --display +<pid>` is the probe that answers
// where a running pid's executable lives now. Read by adoption telemetry and the TCC attribution check.

import { runProcess } from '../../shared/child-process/run-process'
import type { DaemonCodeIdentity } from '../../shared/daemon-adoption-telemetry'

const CODESIGN_TIMEOUT_MS = 3_000

// An unlinked executable prints no `Executable=` and exits 1 with this (Darwin 25.5). The exiting-
// pid error ('host has no guest') means the path did resolve, so it must not match.
const UNLINKED_EXECUTABLE_PATTERN = /No such file or directory/
// Squirrel parks the outgoing bundle under a `…ShipIt…` directory in $TMPDIR or ~/Library/Caches.
const PARKED_BUNDLE_PATTERN = /\/[^/]*ShipIt[^/]*\//

/** `executablePath` is set exactly when codesign printed one (`resolved` or `parked`). */
export type DaemonCodeIdentityProbe = {
  identity: DaemonCodeIdentity
  executablePath: string | null
}

const PROBE_FAILED: DaemonCodeIdentityProbe = { identity: 'probe-failed', executablePath: null }

function readCodesignDisplayOutput(output: string, code: number | null): DaemonCodeIdentityProbe {
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith('Executable=')) {
      const executablePath = line.slice('Executable='.length).trim()
      if (executablePath.length > 0) {
        const identity = PARKED_BUNDLE_PATTERN.test(executablePath) ? 'parked' : 'resolved'
        return { identity, executablePath }
      }
    }
  }
  return code !== 0 && UNLINKED_EXECUTABLE_PATTERN.test(output)
    ? { identity: 'unresolvable', executablePath: null }
    : PROBE_FAILED
}

export function classifyCodesignDisplayOutput(
  output: string,
  code: number | null
): DaemonCodeIdentity {
  return readCodesignDisplayOutput(output, code).identity
}

async function probe(pid: number): Promise<DaemonCodeIdentityProbe> {
  try {
    const result = await runProcess({
      program: '/usr/bin/codesign',
      args: ['--display', '--verbose=1', `+${pid}`],
      timeoutMs: CODESIGN_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    // A killed codesign can still have printed a path; that half-written display proves nothing.
    if (result.timedOut) {
      return PROBE_FAILED
    }
    // codesign writes both the display fields and its diagnostics to stderr.
    return readCodesignDisplayOutput(`${result.stderr}\n${result.stdout}`, result.code)
  } catch {
    return PROBE_FAILED
  }
}

// Concurrent asks about one pid (a burst of spawns) share a probe; nothing outlives it.
let inFlight: { pid: number; pending: Promise<DaemonCodeIdentityProbe> } | null = null

/** Read fresh on every ask: a parked bundle can be deleted mid-run, flipping `parked` to `unresolvable`. */
export function inspectDaemonMacCodeIdentity(
  pid: number | null | undefined
): Promise<DaemonCodeIdentityProbe> {
  if (process.platform !== 'darwin' || !pid || !Number.isSafeInteger(pid) || pid <= 0) {
    return Promise.resolve(PROBE_FAILED)
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
  return (await inspectDaemonMacCodeIdentity(pid)).identity
}
