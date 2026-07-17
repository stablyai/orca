import type { SshConnection } from './ssh-connection'
import { detectSshRelayDarwinProcessTranslation } from './ssh-relay-darwin-translation-detection'
import { detectSshRelayDarwinVersion } from './ssh-relay-darwin-version-detection'
import { detectSshRelayLinuxLibc } from './ssh-relay-libc-detection'
import { detectSshRelayLinuxKernelRelease } from './ssh-relay-linux-kernel-detection'
import { detectSshRelayLinuxLibstdcxx } from './ssh-relay-linux-libstdcxx-detection'
import { detectSshRelayWindowsCompatibility } from './ssh-relay-windows-compatibility-detection'
import type { SshRelayHostEvidence } from './ssh-relay-artifact-selector'
import { getRemoteHostPlatform, type RemoteHostPlatform } from './ssh-remote-platform'

type DetectionOptions = { signal?: AbortSignal }

function isCanonicalPlatform(platform: RemoteHostPlatform): boolean {
  const canonical = getRemoteHostPlatform(platform.relayPlatform)
  return canonical.os === platform.os && canonical.arch === platform.arch
}

async function detectLinuxHostEvidence(
  platform: RemoteHostPlatform,
  connection: SshConnection,
  options: DetectionOptions
): Promise<SshRelayHostEvidence> {
  // Why: independent bounded probes run together so composition adds no serial bootstrap latency.
  const [kernelVersion, libc, libstdcxx] = await Promise.all([
    detectSshRelayLinuxKernelRelease(connection, options),
    detectSshRelayLinuxLibc(connection, options),
    detectSshRelayLinuxLibstdcxx(connection, options)
  ])
  const frozenLibc = Object.freeze({ ...libc })
  return Object.freeze({
    os: 'linux',
    architecture: platform.arch,
    processTranslated: false,
    ...(kernelVersion === undefined ? {} : { kernelVersion }),
    libc: frozenLibc,
    ...(libstdcxx === undefined ? {} : libstdcxx)
  })
}

async function detectDarwinHostEvidence(
  platform: RemoteHostPlatform,
  connection: SshConnection,
  options: DetectionOptions
): Promise<SshRelayHostEvidence | undefined> {
  const [version, processTranslated] = await Promise.all([
    detectSshRelayDarwinVersion(connection, options),
    detectSshRelayDarwinProcessTranslation(connection, options)
  ])
  // Why: guessing native or translated could select incompatible executable bytes.
  if (processTranslated === undefined) {
    return undefined
  }
  return Object.freeze({
    os: 'darwin',
    architecture: platform.arch,
    processTranslated,
    ...(version === undefined ? {} : { version })
  })
}

async function detectWindowsHostEvidence(
  platform: RemoteHostPlatform,
  connection: SshConnection,
  options: DetectionOptions
): Promise<SshRelayHostEvidence> {
  const compatibility = await detectSshRelayWindowsCompatibility(connection, options)
  return Object.freeze({
    os: 'win32',
    architecture: platform.arch,
    processTranslated: false,
    ...compatibility
  })
}

export async function detectSshRelayHostEvidence(
  platform: RemoteHostPlatform,
  connection: SshConnection,
  options: DetectionOptions = {}
): Promise<SshRelayHostEvidence | undefined> {
  // Why: inconsistent caller evidence must not start probes or select a runtime for another tuple.
  if (!isCanonicalPlatform(platform)) {
    return undefined
  }

  if (platform.os === 'linux') {
    return detectLinuxHostEvidence(platform, connection, options)
  }
  if (platform.os === 'darwin') {
    return detectDarwinHostEvidence(platform, connection, options)
  }
  return detectWindowsHostEvidence(platform, connection, options)
}
