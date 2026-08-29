// Transfer-owner identity for relay installs that cross a split shell/SFTP namespace.
//
// The shell and SFTP paths share one validated home-relative suffix
// (`.orca-remote/relay-<fullVersion>`); a random marker inside the shared install
// lock or attempt stage proves which shell-owned directory the SFTP session sees.
//
// See: docs/ssh-relay-sftp-namespace.md

import { RELAY_REMOTE_DIR } from './relay-protocol'
import {
  RELAY_INSTALL_MODEL,
  remoteInstallDirName,
  type RemoteInstallModel
} from './remote-install-model'
import type { SftpNamespacePathMapping } from './sftp-namespace-resolution'
import { shellEscape } from './ssh-connection-utils'
import { RELAY_INSTALL_LOCK_NAME } from './ssh-relay-install-lock'
import { createRelayInstallMarkerFileName } from './ssh-relay-install-marker'
import { makeRemoteDirectoryCommand } from './ssh-remote-commands'
import {
  assertSafeRemotePathSegment,
  joinRemotePath,
  type RemoteHostPlatform,
  type RemotePathFlavor
} from './ssh-remote-platform'

export type RelayInstallNamespace = {
  homeRelativeRelayDir: string
  markerFileName: string
}

export type RelayUploadStageNamespace = {
  homeRelativeStageDir: string
  markerFileName: string
}

/**
 * The two validated segments every relay path is built from. Both the shell
 * builder and the SFTP-relative builder go through here so they cannot drift.
 */
export function relayRemoteDirSegments(
  fullVersion: string,
  pathFlavor: RemotePathFlavor
): string[] {
  return remoteInstallDirSegments(RELAY_INSTALL_MODEL, fullVersion, pathFlavor)
}

/**
 * The model-parameterized form. `relay-<v>` and `orcad-<v>` are permanent siblings under
 * one `.orca-remote/` (see remote-install-model.ts), so the prefix is an argument.
 */
export function remoteInstallDirSegments(
  model: RemoteInstallModel,
  fullVersion: string,
  pathFlavor: RemotePathFlavor
): string[] {
  const segments = [RELAY_REMOTE_DIR, remoteInstallDirName(model, fullVersion)]
  for (const segment of segments) {
    assertSafeRemotePathSegment(segment, pathFlavor)
    // Why: the version reaches logs and diagnostics, where an embedded CR/LF can forge lines.
    if (segment.includes('\r') || segment.includes('\n')) {
      throw new Error(`Unsafe remote path segment: ${JSON.stringify(segment)}`)
    }
  }
  return segments
}

export function relayHomeRelativeDir(fullVersion: string): string {
  return remoteInstallHomeRelativeDir(RELAY_INSTALL_MODEL, fullVersion)
}

export function remoteInstallHomeRelativeDir(
  model: RemoteInstallModel,
  fullVersion: string
): string {
  return remoteInstallDirSegments(model, fullVersion, 'posix').join('/')
}

export function createRelayInstallNamespace(homeRelativeRelayDir: string): RelayInstallNamespace {
  // Why: an unguessable token, not just a unique suffix — a same-version directory
  // under an unrelated SFTP start directory must not qualify as ours.
  return {
    homeRelativeRelayDir,
    markerFileName: createRelayInstallMarkerFileName()
  }
}

export function createRelayUploadStageNamespace(
  homeRelativeStageDir: string,
  markerFileName = createRelayInstallMarkerFileName()
): RelayUploadStageNamespace {
  return {
    homeRelativeStageDir,
    markerFileName
  }
}

/**
 * Describe one relay transfer to the SFTP namespace resolver. `relativeFileName`
 * is omitted for the bundle directory upload itself.
 */
export function relaySftpNamespaceMapping(
  namespace: RelayInstallNamespace,
  host: RemoteHostPlatform,
  shellRelayDir: string,
  relativeFileName?: string
): SftpNamespacePathMapping {
  if (relativeFileName !== undefined) {
    assertSafeRemotePathSegment(relativeFileName, 'posix')
    if (relativeFileName.includes('\r') || relativeFileName.includes('\n')) {
      throw new Error('Unsafe remote path segment in relay SFTP mapping')
    }
  }
  const homeRelativeLockDir = `${namespace.homeRelativeRelayDir}/${RELAY_INSTALL_LOCK_NAME}`
  return {
    homeRelativeNamespaceRoot: namespace.homeRelativeRelayDir,
    homeRelativePath:
      relativeFileName !== undefined
        ? `${namespace.homeRelativeRelayDir}/${relativeFileName}`
        : namespace.homeRelativeRelayDir,
    shellProbePath: relayInstallMarkerShellPath(namespace, host, shellRelayDir),
    homeRelativeProbePath: `${homeRelativeLockDir}/${namespace.markerFileName}`
  }
}

export function relayUploadStageSftpNamespaceMapping(
  namespace: RelayUploadStageNamespace,
  host: RemoteHostPlatform,
  shellStageDir: string,
  relativeFileName?: string
): SftpNamespacePathMapping {
  if (relativeFileName !== undefined) {
    assertSafeRemotePathSegment(relativeFileName, 'posix')
  }
  const homeRelativePayloadDir = `${namespace.homeRelativeStageDir}/payload`
  return {
    homeRelativeNamespaceRoot: namespace.homeRelativeStageDir,
    homeRelativePath:
      relativeFileName === undefined
        ? homeRelativePayloadDir
        : `${homeRelativePayloadDir}/${relativeFileName}`,
    shellProbePath: joinRemotePath(host, shellStageDir, namespace.markerFileName),
    homeRelativeProbePath: `${namespace.homeRelativeStageDir}/${namespace.markerFileName}`
  }
}

export function makeRelayUploadStageDirectoryCommand(
  namespace: RelayUploadStageNamespace,
  host: RemoteHostPlatform,
  shellStageDir: string
): string {
  const payloadDir = joinRemotePath(host, shellStageDir, 'payload')
  const markerPath = joinRemotePath(host, shellStageDir, namespace.markerFileName)
  return `${makeRemoteDirectoryCommand(host, payloadDir)} && umask 077 && touch ${shellEscape(markerPath)}`
}

export function relayInstallMarkerShellPath(
  namespace: RelayInstallNamespace,
  host: RemoteHostPlatform,
  shellRelayDir: string
): string {
  return joinRemotePath(host, shellRelayDir, RELAY_INSTALL_LOCK_NAME, namespace.markerFileName)
}

/**
 * Create the install-owner marker inside the lock this caller already holds.
 * POSIX-only: no marker is created for Windows or the system-SSH transport.
 */
export function createRelayInstallMarkerCommand(
  namespace: RelayInstallNamespace,
  host: RemoteHostPlatform,
  shellRelayDir: string
): string {
  const lockDir = joinRemotePath(host, shellRelayDir, RELAY_INSTALL_LOCK_NAME)
  const markerPath = relayInstallMarkerShellPath(namespace, host, shellRelayDir)
  return `${makeRemoteDirectoryCommand(host, lockDir)} && umask 077 && touch ${shellEscape(markerPath)}`
}

/**
 * First-install directory creation, folded together with marker creation so a
 * standard install spends no extra exec channel on namespace discovery.
 */
export function makeRelayInstallDirectoryCommand(
  host: RemoteHostPlatform,
  shellRelayDir: string,
  namespace?: RelayInstallNamespace
): string {
  const makeDir = makeRemoteDirectoryCommand(host, shellRelayDir)
  if (!namespace) {
    return makeDir
  }
  return `${makeDir} && ${createRelayInstallMarkerCommand(namespace, host, shellRelayDir)}`
}
