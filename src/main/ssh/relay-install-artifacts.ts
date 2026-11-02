/**
 * What a relay-era (≤1.4.224) install directory on a host contains. Orca no longer builds or
 * deploys the relay; the host census reads these names to classify the directories and
 * daemons older versions left behind. Delete with the census.
 */
import { ORCAD_WINDOWS_PROCESS_TREE_FILENAME } from '../../shared/orcad-artifacts'
import { OPENCODE_SQLITE_READER_FILENAME } from '../../shared/remote-bundle-artifacts'

type RelayArtifact = {
  filename: string
  /** Only Windows relays shipped it. */
  windowsOnly?: boolean
  /** Present only when the build could produce it, so an install never required it. */
  optional?: boolean
  /**
   * Forked by the relay daemon as a long-lived child of its own: relay infrastructure, never
   * user work. See relay-daemon-service-children.ts.
   */
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

/**
 * The daemon's own service children, by entry filename. Anything else under a relay pid is
 * either user work or unidentified, and both keep the relay unreapable.
 */
export const RELAY_DAEMON_SERVICE_ENTRY_FILENAMES: readonly string[] = RELAY_ARTIFACTS.filter(
  (artifact) => artifact.daemonServiceChild
).map((artifact) => artifact.filename)

export const RELAY_VERSION_FILENAME = '.version'

/** Written last by the installer; its absence means a torn install. */
export const RELAY_INSTALL_COMPLETE_FILENAME = '.install-complete'

/** Artifacts every complete relay install has. */
export function relayArtifactFilenames(isWindows: boolean): string[] {
  return RELAY_ARTIFACTS.filter(
    (artifact) => !artifact.optional && (!artifact.windowsOnly || isWindows)
  ).map((artifact) => artifact.filename)
}
