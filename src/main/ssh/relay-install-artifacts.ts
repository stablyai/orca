/** Classify legacy relay installs (≤1.4.224) left by older clients; Orca no longer builds/deploys them. Retire this inventory with the host census. */
import { ORCAD_WINDOWS_PROCESS_TREE_FILENAME } from '../../shared/orcad-artifacts'
import { OPENCODE_SQLITE_READER_FILENAME } from '../../shared/remote-bundle-artifacts'

type RelayArtifact = {
  filename: string
  windowsOnly?: boolean
  /** Present only when the build could produce it, so an install never required it. */
  optional?: boolean
  /** Long-lived daemon infrastructure; only these recognized children may be excluded from user-work counts. */
  daemonServiceChild?: boolean
}

const RELAY_ARTIFACTS: readonly RelayArtifact[] = [
  { filename: 'relay.js' },
  { filename: 'relay-watcher.js', daemonServiceChild: true },
  { filename: 'relay-ai-vault-service.js', daemonServiceChild: true },
  { filename: OPENCODE_SQLITE_READER_FILENAME },
  { filename: 'managed-hook-runtime.js' },
  { filename: 'wsl-transcript-fs-process-entry.js' },
  { filename: 'node-pty-1.1.0-console-list-agent-patch.cjs', windowsOnly: true },
  { filename: 'node-pty-1.1.0-windows-pty-teardown-patch.cjs', windowsOnly: true },
  { filename: 'node-pty-1.1.0-master-cloexec-patch.cjs' },
  { filename: ORCAD_WINDOWS_PROCESS_TREE_FILENAME, windowsOnly: true, optional: true }
]

/** Unmatched children remain user work or unknown; either keeps the relay unreapable. */
export const RELAY_DAEMON_SERVICE_ENTRY_FILENAMES: readonly string[] = RELAY_ARTIFACTS.filter(
  (artifact) => artifact.daemonServiceChild
).map((artifact) => artifact.filename)

export const RELAY_VERSION_FILENAME = '.version'

/** Written last by the installer; its absence means a torn install. */
export const RELAY_INSTALL_COMPLETE_FILENAME = '.install-complete'

export function relayArtifactFilenames(isWindows: boolean): string[] {
  return RELAY_ARTIFACTS.filter(
    (artifact) => !artifact.optional && (!artifact.windowsOnly || isWindows)
  ).map((artifact) => artifact.filename)
}
