import type { VerifiedSshRelayArtifactManifest } from './ssh-relay-manifest-signature'
import { sshRelayRuntimeDownloadUrl } from './ssh-relay-release-asset'

type VerifiedSshRelayRuntimeTuple = VerifiedSshRelayArtifactManifest['tuples'][number]

const LINUX_KERNEL_RELEASE_MAX_CHARS = 256

type SshRelayHostBase = {
  architecture: 'x64' | 'arm64'
  processTranslated: boolean
}

export type SshRelayLinuxHostEvidence = SshRelayHostBase & {
  os: 'linux'
  kernelVersion?: string
  libc: { family: 'glibc' | 'musl'; version?: string } | { family: 'unknown' }
  libstdcxxVersion?: string
  glibcxxVersion?: string
}

export type SshRelayDarwinHostEvidence = SshRelayHostBase & {
  os: 'darwin'
  version?: string
}

export type SshRelayWindowsHostEvidence = SshRelayHostBase & {
  os: 'win32'
  build?: number
  openSshVersion?: string
  powerShellVersion?: string
  dotNetFrameworkRelease?: number
}

export type SshRelayHostEvidence =
  | SshRelayLinuxHostEvidence
  | SshRelayDarwinHostEvidence
  | SshRelayWindowsHostEvidence

export type SshRelayArtifactLegacyReason =
  | 'tuple-inconsistent'
  | 'tuple-unavailable'
  | 'tuple-ambiguous'
  | 'translated-process'
  | 'unknown-kernel'
  | 'kernel-too-old'
  | 'unknown-libc'
  | 'libc-too-old'
  | 'unknown-libstdcxx'
  | 'libstdcxx-too-old'
  | 'unknown-os-version'
  | 'os-too-old'
  | 'unknown-openssh'
  | 'openssh-too-old'
  | 'unknown-powershell'
  | 'powershell-too-old'
  | 'unknown-dotnet'
  | 'dotnet-too-old'

export type SshRelayArtifactSelection =
  | {
      readonly kind: 'selected'
      readonly tupleId: VerifiedSshRelayRuntimeTuple['tupleId']
      readonly contentId: VerifiedSshRelayRuntimeTuple['contentId']
      readonly releaseTag: string
      readonly archive: VerifiedSshRelayRuntimeTuple['archive'] & {
        readonly downloadUrl: string
      }
      readonly tuple: VerifiedSshRelayRuntimeTuple
    }
  | { kind: 'legacy'; reason: SshRelayArtifactLegacyReason }

export type SshRelaySelectedArtifact = Extract<SshRelayArtifactSelection, { kind: 'selected' }>

function selectedArtifact(
  tuple: VerifiedSshRelayRuntimeTuple,
  releaseTag: string
): SshRelayArtifactSelection {
  const archive = Object.freeze({
    ...tuple.archive,
    downloadUrl: sshRelayRuntimeDownloadUrl(releaseTag, tuple.archive.name)
  })
  // Why: later download code must not be able to drift the authenticated identity selected here.
  return Object.freeze({
    kind: 'selected',
    tupleId: tuple.tupleId,
    contentId: tuple.contentId,
    releaseTag,
    archive,
    tuple
  })
}

function parseNumericVersion(value: string | undefined): number[] | null {
  if (!value) {
    return null
  }
  const match = /^(\d+(?:\.\d+){1,3})(?:-[0-9A-Za-z.-]+)?$/.exec(value)
  if (!match) {
    return null
  }
  const components = match[1].split('.').map(Number)
  return components.every(Number.isSafeInteger) ? components : null
}

function parseLinuxKernelVersion(value: string | undefined): number[] | null {
  if (!value || value.length > LINUX_KERNEL_RELEASE_MAX_CHARS) {
    return null
  }
  // Why: real distro kernels include `_`, `+`, and `~`; other version fields keep the stricter
  // generic grammar so this compatibility exception cannot weaken unrelated host evidence.
  const match = /^(\d+(?:\.\d+){1,3})(?:-[0-9A-Za-z._+~-]+)?$/.exec(value)
  if (!match) {
    return null
  }
  const components = match[1].split('.').map(Number)
  return components.every(Number.isSafeInteger) ? components : null
}

export function isSshRelayLinuxKernelRelease(value: string | undefined): value is string {
  return parseLinuxKernelVersion(value) !== null
}

function parseOpenSshVersion(value: string | undefined): number[] | null {
  if (!value) {
    return null
  }
  const match = /^(\d+)\.(\d+)p(\d+)$/.exec(value)
  if (!match) {
    return null
  }
  const components = match.slice(1).map(Number)
  return components.every(Number.isSafeInteger) ? components : null
}

function compareComponents(left: number[], right: number[]): number {
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0)
    if (difference !== 0) {
      return difference
    }
  }
  return 0
}

function meetsVersion(
  actual: string | undefined,
  minimum: string,
  parser = parseNumericVersion
): boolean | null {
  const actualParts = parser(actual)
  const minimumParts = parser(minimum)
  if (!actualParts || !minimumParts) {
    return null
  }
  return compareComponents(actualParts, minimumParts) >= 0
}

function selectLinux(
  tuple: VerifiedSshRelayRuntimeTuple,
  host: SshRelayLinuxHostEvidence,
  releaseTag: string
): SshRelayArtifactSelection {
  if (tuple.compatibility.kind !== 'linux') {
    return { kind: 'legacy', reason: 'tuple-inconsistent' }
  }
  const kernel = meetsVersion(
    host.kernelVersion,
    tuple.compatibility.minimumKernelVersion,
    parseLinuxKernelVersion
  )
  if (kernel === null) {
    return { kind: 'legacy', reason: 'unknown-kernel' }
  }
  if (!kernel) {
    return { kind: 'legacy', reason: 'kernel-too-old' }
  }
  if (host.libc.family === 'unknown') {
    return { kind: 'legacy', reason: 'unknown-libc' }
  }
  if (host.libc.family !== tuple.compatibility.libc.family) {
    return { kind: 'legacy', reason: 'tuple-unavailable' }
  }
  const libc = meetsVersion(host.libc.version, tuple.compatibility.libc.minimumVersion)
  if (libc === null) {
    return { kind: 'legacy', reason: 'unknown-libc' }
  }
  if (!libc) {
    return { kind: 'legacy', reason: 'libc-too-old' }
  }

  if (tuple.compatibility.libc.family === 'glibc') {
    const libstdcxx = meetsVersion(
      host.libstdcxxVersion,
      tuple.compatibility.libc.minimumLibstdcxxVersion
    )
    const glibcxx = meetsVersion(
      host.glibcxxVersion,
      tuple.compatibility.libc.minimumGlibcxxVersion
    )
    if (libstdcxx === null || glibcxx === null) {
      return { kind: 'legacy', reason: 'unknown-libstdcxx' }
    }
    if (!libstdcxx || !glibcxx) {
      return { kind: 'legacy', reason: 'libstdcxx-too-old' }
    }
  }
  return selectedArtifact(tuple, releaseTag)
}

function selectDarwin(
  tuple: VerifiedSshRelayRuntimeTuple,
  host: SshRelayDarwinHostEvidence,
  releaseTag: string
): SshRelayArtifactSelection {
  if (tuple.compatibility.kind !== 'darwin') {
    return { kind: 'legacy', reason: 'tuple-inconsistent' }
  }
  const compatible = meetsVersion(host.version, tuple.compatibility.minimumVersion)
  if (compatible === null) {
    return { kind: 'legacy', reason: 'unknown-os-version' }
  }
  return compatible ? selectedArtifact(tuple, releaseTag) : { kind: 'legacy', reason: 'os-too-old' }
}

function selectWindows(
  tuple: VerifiedSshRelayRuntimeTuple,
  host: SshRelayWindowsHostEvidence,
  releaseTag: string
): SshRelayArtifactSelection {
  if (tuple.compatibility.kind !== 'windows') {
    return { kind: 'legacy', reason: 'tuple-inconsistent' }
  }
  if (typeof host.build !== 'number' || !Number.isSafeInteger(host.build)) {
    return { kind: 'legacy', reason: 'unknown-os-version' }
  }
  if (host.build < tuple.compatibility.minimumBuild) {
    return { kind: 'legacy', reason: 'os-too-old' }
  }
  const openSsh = meetsVersion(
    host.openSshVersion,
    tuple.compatibility.minimumOpenSshVersion,
    parseOpenSshVersion
  )
  if (openSsh === null) {
    return { kind: 'legacy', reason: 'unknown-openssh' }
  }
  if (!openSsh) {
    return { kind: 'legacy', reason: 'openssh-too-old' }
  }
  const powerShell = meetsVersion(
    host.powerShellVersion,
    tuple.compatibility.minimumPowerShellVersion
  )
  if (powerShell === null) {
    return { kind: 'legacy', reason: 'unknown-powershell' }
  }
  if (!powerShell) {
    return { kind: 'legacy', reason: 'powershell-too-old' }
  }
  if (
    typeof host.dotNetFrameworkRelease !== 'number' ||
    !Number.isSafeInteger(host.dotNetFrameworkRelease)
  ) {
    return { kind: 'legacy', reason: 'unknown-dotnet' }
  }
  if (host.dotNetFrameworkRelease < tuple.compatibility.minimumDotNetFrameworkRelease) {
    return { kind: 'legacy', reason: 'dotnet-too-old' }
  }
  return selectedArtifact(tuple, releaseTag)
}

export function selectSshRelayArtifact(
  manifest: VerifiedSshRelayArtifactManifest,
  host: SshRelayHostEvidence
): SshRelayArtifactSelection {
  // Why: translated and ambiguous process boundaries stay on the proven legacy path until their
  // own live SSH evidence exists; selecting a native artifact here would be an unsafe guess.
  if (host.processTranslated) {
    return { kind: 'legacy', reason: 'translated-process' }
  }
  const platformCandidates = manifest.tuples.filter(
    (tuple) => tuple.os === host.os && tuple.architecture === host.architecture
  )
  if (host.os === 'linux' && host.libc.family === 'unknown') {
    return { kind: 'legacy', reason: 'unknown-libc' }
  }
  const candidates =
    host.os === 'linux'
      ? platformCandidates.filter(
          (tuple) =>
            tuple.compatibility.kind === 'linux' &&
            tuple.compatibility.libc.family === host.libc.family
        )
      : platformCandidates
  if (candidates.length === 0) {
    return {
      kind: 'legacy',
      reason: platformCandidates.some((tuple) => tuple.compatibility.kind !== host.os)
        ? 'tuple-inconsistent'
        : 'tuple-unavailable'
    }
  }
  if (candidates.length > 1) {
    return { kind: 'legacy', reason: 'tuple-ambiguous' }
  }

  const tuple = candidates[0]
  if (host.os === 'linux') {
    return selectLinux(tuple, host, manifest.build.tag)
  }
  if (host.os === 'darwin') {
    return selectDarwin(tuple, host, manifest.build.tag)
  }
  return selectWindows(tuple, host, manifest.build.tag)
}
