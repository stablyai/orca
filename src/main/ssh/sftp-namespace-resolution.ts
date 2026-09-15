// Resolve an SFTP transfer path when the SSH shell and the SFTP subsystem expose
// different absolute namespaces for the same directory (e.g. Synology DSM's
// /var/services/homes/alice shell home vs. /homes/alice SFTP start directory).
//
// The start directory is not always the home: a chrooted subsystem can open on an
// ancestor of it — DSM lands on the shared-folder list, where that same home is
// /homes/alice or /home — so discovery also searches below the start directory.
//
// See: docs/ssh-relay-sftp-namespace.md

import type { FileEntryWithStats, SFTPWrapper } from 'ssh2'
import { assertSafeRemotePathSegment, isWindowsRemoteHost } from './ssh-remote-platform'
import type { RemoteHostPlatform } from './ssh-remote-platform'
import { redactRelayInstallMarkerTokens } from './ssh-relay-install-marker'

export type SftpNamespacePathMapping = {
  homeRelativeNamespaceRoot: string
  homeRelativePath: string
  shellProbePath: string
  homeRelativeProbePath: string
}

// SSH_FX_NO_SUCH_FILE. The only status that definitively proves a path is absent;
// permission denied, generic failure, and code-less errors are inconclusive.
const SFTP_STATUS_NO_SUCH_FILE = 2

// A start directory that is not the home is a share or export list, not a data
// directory, so a bounded scan of it either finds the home or proves it absent.
const MAX_SCANNED_START_DIRECTORY_ENTRIES = 64

type MarkerProbe =
  | { kind: 'present' }
  | { kind: 'absent' }
  | { kind: 'inconclusive'; detail: string }

function hasNulOrLineBreak(value: string): boolean {
  return value.includes('\0') || value.includes('\r') || value.includes('\n')
}

function assertAbsolutePosixPath(label: string, value: string): void {
  if (!value.startsWith('/') || hasNulOrLineBreak(value)) {
    throw new Error(
      `SFTP namespace ${label} must be an absolute POSIX path: ${JSON.stringify(redactRelayInstallMarkerTokens(value))}`
    )
  }
  // Same segment hygiene as REALPATH start paths — empty/`.`/`..` are programming errors.
  if (value === '/') {
    return
  }
  for (const segment of value.slice(1).split('/')) {
    assertSafeRemotePathSegment(segment, 'posix')
  }
}

function assertHomeRelativePosixPath(label: string, value: string): void {
  if (!value || value.startsWith('/') || hasNulOrLineBreak(value)) {
    throw new Error(
      `SFTP namespace ${label} must be a relative POSIX path: ${JSON.stringify(redactRelayInstallMarkerTokens(value))}`
    )
  }
  for (const segment of value.split('/')) {
    assertSafeRemotePathSegment(segment, 'posix')
  }
}

function assertMappingIdentity(shellAbsolutePath: string, mapping: SftpNamespacePathMapping): void {
  if (!shellAbsolutePath.endsWith(`/${mapping.homeRelativePath}`)) {
    throw new Error('SFTP namespace transfer paths must share one home-relative suffix')
  }

  const probeSegments = mapping.homeRelativeProbePath.split('/')
  const markerFileName = probeSegments.at(-1)
  const shellMarkerFileName = mapping.shellProbePath.slice(
    mapping.shellProbePath.lastIndexOf('/') + 1
  )
  if (!markerFileName || shellMarkerFileName !== markerFileName) {
    throw new Error('SFTP namespace marker paths must share one marker basename')
  }
  const shellNamespacePrefix = shellAbsolutePath.slice(0, -mapping.homeRelativePath.length)
  if (mapping.shellProbePath !== `${shellNamespacePrefix}${mapping.homeRelativeProbePath}`) {
    throw new Error('SFTP namespace transfer and marker must share one shell namespace prefix')
  }

  const namespaceRoot = mapping.homeRelativeNamespaceRoot
  if (
    (mapping.homeRelativePath !== namespaceRoot &&
      !mapping.homeRelativePath.startsWith(`${namespaceRoot}/`)) ||
    !mapping.homeRelativeProbePath.startsWith(`${namespaceRoot}/`)
  ) {
    throw new Error('SFTP namespace transfer and marker must be inside one namespace root')
  }
}

function normalizeSftpStartPath(value: unknown): string | null {
  if (typeof value !== 'string' || !value.startsWith('/') || hasNulOrLineBreak(value)) {
    return null
  }
  if (value === '/') {
    return value
  }
  const normalized = value.replace(/\/+$/, '')
  if (!normalized.startsWith('/')) {
    return null
  }
  const segments = normalized.slice(1).split('/')
  return segments.some((segment) => !segment || segment === '.' || segment === '..')
    ? null
    : normalized
}

function joinSftpStartPath(startPath: string, homeRelativePath: string): string {
  return `${startPath.replace(/\/+$/, '')}/${homeRelativePath}`
}

// Each proper suffix of the shell home, longest first: /var/services/homes/alice
// yields services/homes/alice, homes/alice, alice. One of them is where a chroot
// that truncated the shell prefix re-exposes the home.
function shellHomeSuffixes(shellHome: string): string[] {
  const segments = shellHome.split('/').filter(Boolean)
  return segments.slice(1).map((_segment, index) => segments.slice(index + 1).join('/'))
}

function isSafePosixPathSegment(segment: string): boolean {
  if (segment.includes('\r') || segment.includes('\n')) {
    return false
  }
  try {
    assertSafeRemotePathSegment(segment, 'posix')
    return true
  } catch {
    return false
  }
}

function readdirSftp(
  sftp: SFTPWrapper,
  remotePath: string
): Promise<FileEntryWithStats[] | undefined> {
  return new Promise((resolve) => {
    try {
      sftp.readdir(remotePath, (err, entries) => {
        resolve(err ? undefined : entries)
      })
    } catch {
      resolve(undefined)
    }
  })
}

// Only directories can hold the marker, so plain files cost no probe.
function startDirectoryChildRoots(startPath: string, entries: FileEntryWithStats[]): string[] {
  return entries
    .filter(
      (entry) =>
        isSafePosixPathSegment(entry.filename) &&
        (entry.attrs.isDirectory() || entry.attrs.isSymbolicLink())
    )
    .slice(0, MAX_SCANNED_START_DIRECTORY_ENTRIES)
    .map((entry) => joinSftpStartPath(startPath, entry.filename))
}

function realpathSftp(sftp: SFTPWrapper, remotePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    sftp.realpath(remotePath, (err, resolved) => {
      if (err) {
        reject(err)
        return
      }
      resolve(resolved)
    })
  })
}

// Why: namespace selection must never treat an inconclusive lstat as absence,
// so the probe reports "unknown" rather than collapsing to a boolean.
function probeMarkerPath(sftp: SFTPWrapper, remotePath: string): Promise<MarkerProbe> {
  return new Promise((resolve) => {
    sftp.lstat(remotePath, (err) => {
      if (!err) {
        resolve({ kind: 'present' })
        return
      }
      const code = (err as { code?: unknown }).code
      if (code === SFTP_STATUS_NO_SUCH_FILE) {
        resolve({ kind: 'absent' })
        return
      }
      resolve({
        kind: 'inconclusive',
        detail:
          typeof code === 'number' ? `status ${code}` : redactRelayInstallMarkerTokens(err.message)
      })
    })
  })
}

function logRetainedShellPath(operation: string, detail: string, shellAbsolutePath: string): void {
  console.warn(
    `[ssh-relay] SFTP namespace discovery inconclusive (${operation}: ${redactRelayInstallMarkerTokens(detail)}); retaining shell path ${redactRelayInstallMarkerTokens(shellAbsolutePath)}`
  )
}

// Why: a candidate is adopted only on its own marker hit, so an inconclusive probe
// must neither adopt it nor end the search; details are collected for one warning.
async function findMarkedTransferPath(
  sftp: SFTPWrapper,
  namespaceRoots: string[],
  mapping: SftpNamespacePathMapping,
  inconclusive: string[]
): Promise<string | null> {
  for (const namespaceRoot of namespaceRoots) {
    const probe = await probeMarkerPath(
      sftp,
      joinSftpStartPath(namespaceRoot, mapping.homeRelativeProbePath)
    )
    if (probe.kind === 'present') {
      return joinSftpStartPath(namespaceRoot, mapping.homeRelativePath)
    }
    if (probe.kind === 'inconclusive') {
      inconclusive.push(probe.detail)
    }
  }
  return null
}

/**
 * Pick the path this SFTP session should transfer to.
 *
 * Returns `shellAbsolutePath` unless the session both fails to see the install
 * owner's marker there and does see it under the start directory, under a suffix
 * of the shell home below it, or under one of the start directory's children.
 * Discovery failures degrade to the shell path rather than inventing a namespace
 * error.
 */
export async function resolveSftpTransferPath(
  sftp: SFTPWrapper,
  shellAbsolutePath: string,
  mapping: SftpNamespacePathMapping
): Promise<string> {
  assertAbsolutePosixPath('transfer path', shellAbsolutePath)
  assertAbsolutePosixPath('marker path', mapping.shellProbePath)
  assertHomeRelativePosixPath('relative namespace root', mapping.homeRelativeNamespaceRoot)
  assertHomeRelativePosixPath('relative transfer path', mapping.homeRelativePath)
  assertHomeRelativePosixPath('relative marker path', mapping.homeRelativeProbePath)
  assertMappingIdentity(shellAbsolutePath, mapping)

  let reportedStartPath: unknown
  try {
    reportedStartPath = await realpathSftp(sftp, '.')
  } catch (err) {
    logRetainedShellPath(
      'REALPATH',
      err instanceof Error ? err.message : String(err),
      shellAbsolutePath
    )
    return shellAbsolutePath
  }
  const startPath = normalizeSftpStartPath(reportedStartPath)
  if (!startPath) {
    logRetainedShellPath('REALPATH', 'unusable start directory', shellAbsolutePath)
    return shellAbsolutePath
  }

  if (joinSftpStartPath(startPath, mapping.homeRelativePath) === shellAbsolutePath) {
    return shellAbsolutePath
  }

  const shellMarker = await probeMarkerPath(sftp, mapping.shellProbePath)
  if (shellMarker.kind !== 'absent') {
    if (shellMarker.kind === 'inconclusive') {
      logRetainedShellPath('LSTAT', shellMarker.detail, shellAbsolutePath)
    }
    return shellAbsolutePath
  }

  const inconclusive: string[] = []
  const shellHome = shellAbsolutePath.slice(0, -(mapping.homeRelativePath.length + 1))
  const suffixRoots = shellHomeSuffixes(shellHome).map((suffix) =>
    joinSftpStartPath(startPath, suffix)
  )
  let transferPath = await findMarkedTransferPath(
    sftp,
    [startPath, ...suffixRoots],
    mapping,
    inconclusive
  )
  if (!transferPath) {
    const entries = await readdirSftp(sftp, startPath)
    if (entries) {
      transferPath = await findMarkedTransferPath(
        sftp,
        startDirectoryChildRoots(startPath, entries),
        mapping,
        inconclusive
      )
    } else {
      inconclusive.push('READDIR failed')
    }
  }

  if (transferPath) {
    console.log(
      `[ssh-relay] SFTP namespace differs; transfer path: ${redactRelayInstallMarkerTokens(transferPath)}`
    )
    return transferPath
  }
  if (inconclusive.length > 0) {
    logRetainedShellPath('search', inconclusive.join('; '), shellAbsolutePath)
  }
  return shellAbsolutePath
}

export type SftpTransferPathOptions = {
  hostPlatform?: RemoteHostPlatform
  sftpNamespace?: SftpNamespacePathMapping
}

/**
 * Namespace-resolve a transfer path only when a mapping was supplied and the host
 * is not Windows, whose SFTP drive paths (`/C:/Users/...`) break the POSIX prefix
 * contract. Callers without a mapping issue no REALPATH or LSTAT.
 */
export function resolveSftpTransferPathIfMapped(
  sftp: SFTPWrapper,
  shellAbsolutePath: string,
  options?: SftpTransferPathOptions
): Promise<string> {
  const mapping = options?.sftpNamespace
  if (
    !mapping ||
    (options?.hostPlatform && isWindowsRemoteHost(options.hostPlatform)) ||
    (!options?.hostPlatform && isRecognizableWindowsAbsolutePath(shellAbsolutePath))
  ) {
    return Promise.resolve(shellAbsolutePath)
  }
  return resolveSftpTransferPath(sftp, shellAbsolutePath, mapping)
}

function isRecognizableWindowsAbsolutePath(value: string): boolean {
  return (
    /^[A-Za-z]:[\\/]/u.test(value) ||
    value.startsWith('\\\\') ||
    /^\/[A-Za-z]:\//u.test(value) ||
    /^\/\/[^/]/u.test(value)
  )
}
