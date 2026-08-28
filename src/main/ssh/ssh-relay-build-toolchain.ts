import { execCommand } from './ssh-relay-deploy-helpers'
import type { SshConnection } from './ssh-connection'
import { isWindowsRemoteHost, type RemoteHostPlatform } from './ssh-remote-platform'
import {
  buildToolchainProbeCommand,
  parseBuildToolchainProbe,
  type BuildToolchainStatus
} from './build-toolchain-diagnosis'

// Why re-exported rather than moved outright: `ssh-relay-deploy.ts` and the relay tests
// import the whole diagnosis surface from here, and the split exists for bundle reasons,
// not to redraw the relay's own API.
export {
  buildToolchainProbeCommand,
  parseBuildToolchainProbe,
  shouldProbeBuildToolchainAfterNativeDepsFailure,
  toolchainInstallHintLines,
  formatSkippedNodePtyWarning,
  formatMissingToolchainError
} from './build-toolchain-diagnosis'
export type { BuildToolchainStatus } from './build-toolchain-diagnosis'

// Best-effort: returns null on Windows hosts (node-pty ships win32 prebuilds, so
// a missing toolchain isn't the failure there) or if the probe itself errors —
// callers fall back to the original install error in those cases.
export async function probeBuildToolchain(
  conn: SshConnection,
  hostPlatform: RemoteHostPlatform,
  signal?: AbortSignal
): Promise<BuildToolchainStatus | null> {
  if (isWindowsRemoteHost(hostPlatform)) {
    return null
  }
  try {
    const output = await execCommand(conn, buildToolchainProbeCommand(), {
      wrapCommand: true,
      signal
    })
    return parseBuildToolchainProbe(output)
  } catch {
    signal?.throwIfAborted()
    return null
  }
}
