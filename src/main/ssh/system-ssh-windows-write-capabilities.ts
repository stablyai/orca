import type { SshTarget } from '../../shared/ssh-types'
import { CapabilityProbeCache } from '../../shared/capability-probe-cache'

/**
 * Whether a Windows host can take a file write over the sftp subsystem, and whether it has a
 * PowerShell 7 to fall back to. Both are host facts, so they are cached per execution host rather
 * than per transfer — a hardened host with `Subsystem sftp` removed must not be re-probed on every
 * file of a multi-file upload.
 */
export type WindowsRemoteWriteCapability = 'sftp-subsystem' | 'pwsh'

// Why re-probe at all: an admin can enable the subsystem, or install PowerShell 7, without the
// user restarting Orca. Long enough that a hardened host costs one failed probe per half hour.
export const WINDOWS_WRITE_CAPABILITY_RETRY_INTERVAL_MS = 30 * 60_000

const capabilitiesByExecutionHost = new Map<
  string,
  CapabilityProbeCache<WindowsRemoteWriteCapability>
>()

/**
 * Keyed by the endpoint that executes, not by target id: two Orca targets pointing at one host
 * describe the same sshd, and a target re-created under a new id has not changed what that host
 * supports. A config alias is its own key because ssh_config, not Orca, resolves where it lands.
 */
export function getWindowsRemoteWriteExecutionHostKey(target: SshTarget): string {
  if (target.configHost) {
    return `config:${target.configHost}`
  }
  const port = target.port ?? 22
  return target.username
    ? `host:${target.username}@${target.host}:${port}`
    : `host:${target.host}:${port}`
}

export function getWindowsRemoteWriteCapabilities(
  target: SshTarget
): CapabilityProbeCache<WindowsRemoteWriteCapability> {
  const key = getWindowsRemoteWriteExecutionHostKey(target)
  let cache = capabilitiesByExecutionHost.get(key)
  if (!cache) {
    cache = new CapabilityProbeCache<WindowsRemoteWriteCapability>(
      WINDOWS_WRITE_CAPABILITY_RETRY_INTERVAL_MS
    )
    capabilitiesByExecutionHost.set(key, cache)
  }
  return cache
}

export function clearWindowsRemoteWriteCapabilitiesForTests(): void {
  capabilitiesByExecutionHost.clear()
}
