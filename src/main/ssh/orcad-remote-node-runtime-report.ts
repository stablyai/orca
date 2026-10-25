import { parseMissingSharedLibrary } from '../orcad/native-host-abi'
import { RelayHostAnsweredError } from './remote-exec/remote-host-answered-failure'

export const REMOTE_NODE_RUNTIME_READY = 'ORCA_NODE_RUNTIME_READY'
export const REMOTE_NODE_RUNTIME_MISSING = 'ORCA_NODE_RUNTIME_MISSING'
export const REMOTE_NODE_RUNTIME_SELFTEST_FAILED = 'ORCA_NODE_RUNTIME_SELFTEST_FAILED'
export const REMOTE_NODE_RUNTIME_NOEXEC = 'ORCA_NODE_RUNTIME_NOEXEC'
export const REMOTE_NODE_RUNTIME_SECURITY_MODIFIED = 'ORCA_NODE_RUNTIME_SECURITY_MODIFIED'
export const REMOTE_NODE_RUNTIME_EXIT_PREFIX = 'ORCA_RUNTIME_EXIT='
export const REMOTE_NODE_RUNTIME_VERIFIED_MARKER = '.verified'

/** A failed version self-test is positive host evidence, not an unanswered transport probe. */
export class RemoteNodeRuntimeSelfTestError extends RelayHostAnsweredError {
  constructor(
    readonly exitStatus: number | null,
    readonly output: string
  ) {
    const exit = `exit ${exitStatus ?? 'unknown'}`
    const missing = parseMissingSharedLibrary(output)
    super(
      missing
        ? `The host is missing ${missing}, which Orca's Node runtime needs. ` +
            `${installHint(missing)} Then reconnect. (${exit}: ${output})`
        : `The pinned Node runtime did not run on the host (${exit}): ${output}`
    )
    this.name = 'RemoteNodeRuntimeSelfTestError'
  }
}

export class RemoteNodeRuntimeNoexecError extends RelayHostAnsweredError {
  constructor(
    readonly output: string,
    storeDir = 'Orca’s runtime folder'
  ) {
    super(`The host does not allow running programs from ${storeDir}: ${output}`)
    this.name = 'RemoteNodeRuntimeNoexecError'
  }
}

/** Only exec refusal fails this probe; other uncertainty falls through to upload self-test for loader diagnostics. */
export function assertRemoteNodeRuntimeStoreExecutable(probe: string, storeDir: string): void {
  const index = probe.indexOf(REMOTE_NODE_RUNTIME_NOEXEC)
  if (index === -1) {
    return
  }
  const report = parseRemoteRuntimeExitReport(probe.slice(index))
  // Our own 0700 shell script makes exit 126 an exec refusal; diagnostic text may be localized.
  if (report.exitStatus === 126) {
    throw new RemoteNodeRuntimeNoexecError(report.output, storeDir)
  }
}

// Alpine is the one supported family that ships without libstdc++ by default.
function installHint(library: string): string {
  return library.startsWith('libstdc++')
    ? 'Install it (Alpine: apk add libstdc++; Debian/Ubuntu: apt install libstdc++6; Fedora: dnf install libstdc++).'
    : 'Install the package that provides it.'
}

export class RemoteNodeRuntimeSecurityModifiedError extends RelayHostAnsweredError {
  constructor(readonly detail: string) {
    super(`Security software on the host removed or modified the pinned Node runtime: ${detail}`)
    this.name = 'RemoteNodeRuntimeSecurityModifiedError'
  }
}

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
