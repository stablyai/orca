/** What the host-side runtime-store scripts print, shared by the POSIX and Windows installers. */

export const REMOTE_NODE_RUNTIME_READY = 'ORCA_NODE_RUNTIME_READY'
export const REMOTE_NODE_RUNTIME_MISSING = 'ORCA_NODE_RUNTIME_MISSING'
export const REMOTE_NODE_RUNTIME_SELFTEST_FAILED = 'ORCA_NODE_RUNTIME_SELFTEST_FAILED'
/** A file Orca wrote and verified changed or vanished afterwards; the rest of the line says which. */
export const REMOTE_NODE_RUNTIME_SECURITY_MODIFIED = 'ORCA_NODE_RUNTIME_SECURITY_MODIFIED'
export const REMOTE_NODE_RUNTIME_EXIT_PREFIX = 'ORCA_RUNTIME_EXIT='
export const REMOTE_NODE_RUNTIME_VERIFIED_MARKER = '.verified'

/** The pinned runtime ran on the host and did not report its version: a host verdict, with evidence. */
export class RemoteNodeRuntimeSelfTestError extends Error {
  constructor(
    readonly exitStatus: number | null,
    readonly output: string
  ) {
    super(
      `The pinned Node runtime did not run on the host (exit ${exitStatus ?? 'unknown'}): ${output}`
    )
    this.name = 'RemoteNodeRuntimeSelfTestError'
  }
}

/** The host answered, and what it answered is that something rewrote or removed our verified bytes. */
export class RemoteNodeRuntimeSecurityModifiedError extends Error {
  constructor(readonly detail: string) {
    super(`Security software on the host removed or modified the pinned Node runtime: ${detail}`)
    this.name = 'RemoteNodeRuntimeSecurityModifiedError'
  }
}

/** Splits `ORCA_RUNTIME_EXIT=<n>` from the output that follows it. */
export function parseRemoteRuntimeExitReport(text: string): {
  exitStatus: number | null
  output: string
} {
  const lines = text.split(/\r?\n/)
  const index = lines.findIndex((line) => line.startsWith(REMOTE_NODE_RUNTIME_EXIT_PREFIX))
  if (index === -1) {
    return { exitStatus: null, output: text.trim() }
  }
  const status = Number.parseInt(lines[index].slice(REMOTE_NODE_RUNTIME_EXIT_PREFIX.length), 10)
  return {
    exitStatus: Number.isNaN(status) ? null : status,
    output: lines
      .slice(index + 1)
      .join('\n')
      .trim()
  }
}

/** Throws the host's verdict when a promote script reported one instead of READY. */
export function assertRemoteNodeRuntimePromoted(promoted: string): void {
  const selfTestFailure = promoted.indexOf(REMOTE_NODE_RUNTIME_SELFTEST_FAILED)
  if (selfTestFailure !== -1) {
    const report = parseRemoteRuntimeExitReport(promoted.slice(selfTestFailure))
    throw new RemoteNodeRuntimeSelfTestError(report.exitStatus, report.output)
  }
  const modified = promoted
    .split(/\r?\n/)
    .find((line) => line.startsWith(REMOTE_NODE_RUNTIME_SECURITY_MODIFIED))
  if (modified !== undefined) {
    throw new RemoteNodeRuntimeSecurityModifiedError(
      modified.slice(REMOTE_NODE_RUNTIME_SECURITY_MODIFIED.length).trim()
    )
  }
  if (promoted.trim().split(/\r?\n/).at(-1)?.trim() !== REMOTE_NODE_RUNTIME_READY) {
    throw new Error(`The host did not verify the pinned Node runtime: ${promoted.trim()}`)
  }
}
