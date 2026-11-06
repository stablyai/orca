import type { SshTarget } from '../../../shared/ssh-types'
import { CapabilityProbeCache } from '../../../shared/capability-probe-cache'

/** Cache SFTP/PowerShell 7 absence per execution host to avoid per-file probes. */
type WindowsRemoteWriteCapability = 'sftp-subsystem' | 'pwsh'

// Reprobe so admins can enable SFTP/install PowerShell 7 without restarting Orca.
const WINDOWS_WRITE_CAPABILITY_RETRY_INTERVAL_MS = 30 * 60_000
const MAX_WINDOWS_WRITE_CAPABILITY_HOSTS = 256

const capabilitiesByExecutionHost = new Map<
  string,
  CapabilityProbeCache<WindowsRemoteWriteCapability>
>()

function rememberCapabilityCache(
  key: string,
  cache: CapabilityProbeCache<WindowsRemoteWriteCapability>
): CapabilityProbeCache<WindowsRemoteWriteCapability> {
  capabilitiesByExecutionHost.delete(key)
  capabilitiesByExecutionHost.set(key, cache)
  while (capabilitiesByExecutionHost.size > MAX_WINDOWS_WRITE_CAPABILITY_HOSTS) {
    const oldest = capabilitiesByExecutionHost.keys().next().value
    if (oldest === undefined) {
      break
    }
    capabilitiesByExecutionHost.delete(oldest)
  }
  return cache
}

/** Duplicate/recreated targets share endpoint facts; config aliases remain separate because ssh_config resolves them. */
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
  }
  return rememberCapabilityCache(key, cache)
}

export function clearWindowsRemoteWriteCapabilitiesForTests(): void {
  capabilitiesByExecutionHost.clear()
}
