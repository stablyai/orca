import { homedir } from 'node:os'
import { join } from 'node:path'
import { readFileSync, statSync } from 'node:fs'
import {
  findTransport,
  getRuntimeMetadataPath,
  type RuntimeMetadata
} from '../../../shared/remote-runtime/bootstrap/runtime-bootstrap'
import { runtimeAccessDeniedError } from '../connection/runtime-access-denied'
import { RuntimeClientError } from '../connection/types'

export function readMetadata(userDataPath: string): RuntimeMetadata {
  const metadataPath = getRuntimeMetadataPath(userDataPath)
  try {
    const metadata = JSON.parse(readFileSync(metadataPath, 'utf8')) as RuntimeMetadata | null
    if (!metadata || !findTransport(metadata, 'unix', 'named-pipe') || !metadata.authToken) {
      throw new RuntimeClientError(
        'runtime_unavailable',
        `Orca runtime metadata is incomplete at ${metadataPath}`
      )
    }
    return metadata
  } catch (error) {
    if (error instanceof RuntimeClientError) {
      throw error
    }
    const denied = error instanceof Error ? runtimeAccessDeniedError(error, metadataPath) : null
    throw (
      denied ??
      new RuntimeClientError(
        'runtime_unavailable',
        `Could not read Orca runtime metadata at ${metadataPath}. Start the Orca app first.`
      )
    )
  }
}

// Offline admission and serve preflight treat a denied read as absent; status opts in to report it.
export function tryReadMetadata(
  userDataPath: string,
  { throwOnAccessDenied = false }: { throwOnAccessDenied?: boolean } = {}
): RuntimeMetadata | null {
  const metadataPath = getRuntimeMetadataPath(userDataPath)
  try {
    return JSON.parse(readFileSync(metadataPath, 'utf8')) as RuntimeMetadata | null
  } catch (error) {
    const denied =
      throwOnAccessDenied && error instanceof Error
        ? runtimeAccessDeniedError(error, metadataPath)
        : null
    if (denied && shouldReportDenial(metadataPath)) {
      throw denied
    }
    return null
  }
}

function shouldReportDenial(path: string): boolean {
  const uid = process.getuid?.()
  // Windows has no uid to compare, and its EPERM can be a transient replace or an elevated run's file.
  if (uid === undefined) {
    return false
  }
  try {
    // Another user's file (e.g. left by sudo) is stale for us; a launch replaces it, as before.
    return statSync(path).uid === uid
  } catch {
    return true
  }
}

export function getDefaultUserDataPath(
  platform: NodeJS.Platform = process.platform,
  homeDir = homedir()
): string {
  if (process.env.ORCA_USER_DATA_PATH) {
    return process.env.ORCA_USER_DATA_PATH
  }
  return getPlatformUserDataPath(platform, homeDir)
}

/** The packaged app's own default profile, ignoring any CLI override. */
export function getPlatformUserDataPath(
  platform: NodeJS.Platform = process.platform,
  homeDir = homedir()
): string {
  if (platform === 'darwin') {
    return join(homeDir, 'Library', 'Application Support', 'orca')
  }
  if (platform === 'win32') {
    const appData = process.env.APPDATA
    if (!appData) {
      throw new RuntimeClientError(
        'runtime_unavailable',
        'APPDATA is not set, so the Orca runtime metadata path cannot be resolved.'
      )
    }
    return join(appData, 'orca')
  }
  // Match Electron’s packaged userData path.
  return join(process.env.XDG_CONFIG_HOME || join(homeDir, '.config'), 'orca')
}
