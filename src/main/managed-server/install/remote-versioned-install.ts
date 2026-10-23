// Versioned-install plumbing for orcad on a remote host: each content-hashed bundle installs
// into its own immutable dir, so an in-memory daemon never serves new clients off overwritten
// on-disk code.

import { join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import type { RemoteInstallTransport } from './remote-install-transport'
import { execHostCommand } from '../../ssh/remote-exec/remote-host-exec'
import { isUnconfirmedSshCommandTermination } from '../../ssh/remote-exec/remote-exec-command'
import { RELAY_INSTALL_LOCK_NAME } from '../../../shared/relay-install-lock-name'
import { RELAY_REMOTE_DIR } from '../../ssh/remote-exec/remote-frame-protocol'
import { remoteInstallDirName, type RemoteInstallModel } from './remote-install-model'
import {
  probeRemoteInstallCompleteCommand,
  removeRemoteTreeCommand,
  writeRemoteEmptyFileCommand
} from '../../ssh/ssh-remote-commands'
import {
  assertSafeRemotePathSegment,
  getRemoteHostPlatform,
  joinRemotePath,
  type RemoteHostPlatform,
  type RemotePathFlavor
} from '../../ssh/ssh-remote-platform'
import { isSshSessionLimitError } from '../../ssh/ssh-session-limit-error'

const INSTALL_COMPLETE_NAME = '.install-complete'
const DEFAULT_REMOTE_HOST = getRemoteHostPlatform('linux-x64')

type RemoteInstallProbeOptions = {
  rethrowSessionLimitErrors?: boolean
  signal?: AbortSignal
}

/**
 * Read the local relay's content-hashed version (e.g. "0.1.0+0a5fe134d020") from
 * `${localRelayDir}/.version`. Throws on missing/empty so the caller can't
 * silently fall back to a path where a stale-generation daemon may be running.
 */
export function readLocalFullVersion(localRelayDir: string): string {
  const versionFile = join(localRelayDir, '.version')
  if (!existsSync(versionFile)) {
    throw new Error(
      `Orca's local relay build is missing its version marker at ${versionFile}. ` +
        `This usually indicates a packaging or build problem; reinstall Orca.`
    )
  }
  const v = readFileSync(versionFile, 'utf-8').trim()
  if (!v) {
    throw new Error(
      `Orca's local relay version marker at ${versionFile} is empty. ` +
        `This usually indicates a packaging or build problem; reinstall Orca.`
    )
  }
  return v
}

/** `${remoteHome}/.orca-remote/<prefix>-<fullVersion>` for one install model. */
export function computeRemoteInstallDir(
  model: RemoteInstallModel,
  remoteHome: string,
  fullVersion: string,
  pathFlavor: RemotePathFlavor = 'posix'
): string {
  const host =
    pathFlavor === 'windows'
      ? getRemoteHostPlatform('win32-x64')
      : getRemoteHostPlatform('linux-x64')
  return joinRemotePath(
    host,
    remoteHome,
    ...remoteInstallDirSegments(model, fullVersion, pathFlavor)
  )
}

/** Every artifact the model ships plus its completion sentinel; anything missing forces a re-deploy. */
export async function isRemoteInstallComplete(
  conn: RemoteInstallTransport,
  model: RemoteInstallModel,
  remoteInstallDir: string,
  host: RemoteHostPlatform = DEFAULT_REMOTE_HOST,
  options?: RemoteInstallProbeOptions
): Promise<boolean> {
  try {
    const probe = await execHostCommand(
      conn,
      host,
      probeRemoteInstallCompleteCommand(host, remoteInstallDir, [
        ...model.requiredArtifacts(host),
        model.installCompleteFilename
      ]),
      { signal: options?.signal }
    )
    return probe.trim() === 'OK'
  } catch (err) {
    if (isUnconfirmedSshCommandTermination(err)) {
      throw err
    }
    options?.signal?.throwIfAborted()
    if (options?.rethrowSessionLimitErrors && isSshSessionLimitError(err)) {
      throw err
    }
    return false
  }
}

/**
 * Mark the install complete, then normally release the lock. Deploy keeps the
 * lock through first launch so cross-version GC can't move the dir before daemon
 * liveness is observable.
 */
export async function finalizeInstall(
  conn: RemoteInstallTransport,
  remoteRelayDir: string,
  host: RemoteHostPlatform = DEFAULT_REMOTE_HOST,
  options?: { signal?: AbortSignal; releaseLock?: boolean }
): Promise<void> {
  const sentinel = joinRemotePath(host, remoteRelayDir, INSTALL_COMPLETE_NAME)
  const lock = joinRemotePath(host, remoteRelayDir, RELAY_INSTALL_LOCK_NAME)
  await execHostCommand(conn, host, writeRemoteEmptyFileCommand(host, sentinel), {
    signal: options?.signal
  })
  if (options?.releaseLock !== false) {
    await execHostCommand(conn, host, removeRemoteTreeCommand(host, lock), {
      signal: options?.signal
    }).catch((error) => {
      if (isUnconfirmedSshCommandTermination(error)) {
        throw error
      }
    })
  }
  options?.signal?.throwIfAborted()
}

/**
 * Release the install lock without writing the completion sentinel, leaving the
 * dir as a recoverable partial the next deploy re-installs.
 */
export async function abandonInstall(
  conn: RemoteInstallTransport,
  remoteRelayDir: string,
  host: RemoteHostPlatform = DEFAULT_REMOTE_HOST
): Promise<boolean> {
  const lock = joinRemotePath(host, remoteRelayDir, RELAY_INSTALL_LOCK_NAME)
  return execHostCommand(conn, host, removeRemoteTreeCommand(host, lock)).then(
    () => true,
    (error) => {
      if (isUnconfirmedSshCommandTermination(error)) {
        throw error
      }
      // Not confirmed removed: the lock may remain.
      return false
    }
  )
}

/** Shell and SFTP-relative builders both go through here so their namespaces cannot drift. */
function remoteInstallDirSegments(
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
