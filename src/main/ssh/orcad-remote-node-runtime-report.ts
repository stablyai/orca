/** What the host-side runtime-store scripts print, shared by the POSIX and Windows installers. */
import { RelayHostAnsweredError } from './remote-exec/remote-host-answered-failure'

export const REMOTE_NODE_RUNTIME_READY = 'ORCA_NODE_RUNTIME_READY'
export const REMOTE_NODE_RUNTIME_MISSING = 'ORCA_NODE_RUNTIME_MISSING'
export const REMOTE_NODE_RUNTIME_SELFTEST_FAILED = 'ORCA_NODE_RUNTIME_SELFTEST_FAILED'
/** The store's filesystem refused to execute a file Orca wrote there; the shell's words follow. */
export const REMOTE_NODE_RUNTIME_NOEXEC = 'ORCA_NODE_RUNTIME_NOEXEC'
/** A file Orca wrote and verified changed or vanished afterwards; the rest of the line says which. */
export const REMOTE_NODE_RUNTIME_SECURITY_MODIFIED = 'ORCA_NODE_RUNTIME_SECURITY_MODIFIED'
export const REMOTE_NODE_RUNTIME_EXIT_PREFIX = 'ORCA_RUNTIME_EXIT='
export const REMOTE_NODE_RUNTIME_VERIFIED_MARKER = '.verified'

/** The pinned runtime ran on the host and did not report its version: a host verdict, with evidence. */
export class RemoteNodeRuntimeSelfTestError extends RelayHostAnsweredError {
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

/** The host refuses to run programs from the runtime store, e.g. a home mounted `noexec`. */
export class RemoteNodeRuntimeNoexecError extends RelayHostAnsweredError {
  constructor(
    readonly output: string,
    storeDir = 'Orca’s runtime folder'
  ) {
    super(`The host does not allow running programs from ${storeDir}: ${output}`)
    this.name = 'RemoteNodeRuntimeNoexecError'
  }
}

/**
 * Throws only for the shell's exec refusal; any other probe failure falls through to the upload,
 * whose self-test classifies it with the loader's own words.
 */
export function assertRemoteNodeRuntimeStoreExecutable(probe: string, storeDir: string): void {
  const index = probe.indexOf(REMOTE_NODE_RUNTIME_NOEXEC)
  if (index === -1) {
    return
  }
  const report = parseRemoteRuntimeExitReport(probe.slice(index))
  // Why the status alone: 126 is "found but not executable", and the probe is our own 0700 /bin/sh
  // script, so only an exec refusal is left; the shell's words may be localized.
  if (report.exitStatus === 126) {
    throw new RemoteNodeRuntimeNoexecError(report.output, storeDir)
  }
}

/** The host answered, and what it answered is that something rewrote or removed our verified bytes. */
export class RemoteNodeRuntimeSecurityModifiedError extends RelayHostAnsweredError {
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
    throw new RelayHostAnsweredError(
      `The host did not verify the pinned Node runtime: ${promoted.trim()}`
    )
  }
}
