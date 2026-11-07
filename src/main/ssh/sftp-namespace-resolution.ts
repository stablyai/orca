// Map differing shell/SFTP namespaces, such as Synology /var/services/homes/alice vs /homes/alice. See docs/ssh-relay-sftp-namespace.md.

import type { SFTPWrapper } from 'ssh2'
import { assertSafeRemotePathSegment, isWindowsRemoteHost } from './ssh-remote-platform'
import type { RemoteHostPlatform } from './ssh-remote-platform'
import { redactRelayInstallMarkerTokens } from '../managed-server/install/remote-install-marker'

export type SftpNamespacePathMapping = {
  homeRelativeNamespaceRoot: string
  homeRelativePath: string
  shellProbePath: string
  homeRelativeProbePath: string
}

// Only SSH_FX_NO_SUCH_FILE proves absence; permission/generic/code-less failures stay unknown.
const SFTP_STATUS_NO_SUCH_FILE = 2

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

// Preserve unknown lstat results; uncertainty cannot authorize namespace redirect.
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

/** Redirect only when the owner marker is proven absent at the shell path and present under SFTP start. Uncertain discovery keeps the original path. */
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

  const candidatePath = joinSftpStartPath(startPath, mapping.homeRelativePath)
  if (candidatePath === shellAbsolutePath) {
    return shellAbsolutePath
  }

  const shellMarker = await probeMarkerPath(sftp, mapping.shellProbePath)
  if (shellMarker.kind !== 'absent') {
    if (shellMarker.kind === 'inconclusive') {
      logRetainedShellPath('LSTAT', shellMarker.detail, shellAbsolutePath)
    }
    return shellAbsolutePath
  }

  const candidateMarker = await probeMarkerPath(
    sftp,
    joinSftpStartPath(startPath, mapping.homeRelativeProbePath)
  )
  if (candidateMarker.kind === 'present') {
    console.log(
      `[ssh-relay] SFTP namespace differs; transfer path: ${redactRelayInstallMarkerTokens(candidatePath)}`
    )
    return candidatePath
  }
  if (candidateMarker.kind === 'inconclusive') {
    logRetainedShellPath('LSTAT', candidateMarker.detail, shellAbsolutePath)
  }
  return shellAbsolutePath
}

type SftpTransferPathOptions = {
  hostPlatform?: RemoteHostPlatform
  sftpNamespace?: SftpNamespacePathMapping
}

/** Map only explicitly supplied POSIX namespaces; Windows /C:/ drive paths violate prefix rules. Unmapped calls issue no discovery requests. */
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
