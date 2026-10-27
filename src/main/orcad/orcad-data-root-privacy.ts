import { chmodSync, statSync } from 'node:fs'
import process from 'node:process'
import { restrictWindowsPathSync } from '../../shared/secure-path-windows-acl'

type OrcadInstanceLockCode =
  | 'orcad_data_root_unusable'
  | 'orcad_data_root_wrong_owner'
  | 'orcad_data_root_shared'
  | 'orcad_instance_lock_held'
  /** Shared-home/foreign-machine owners may still run and cannot be judged here. */
  | 'orcad_instance_lock_holder_unverifiable'
  | 'orcad_instance_lock_foreign_identity'
  | 'orcad_instance_lock_unreadable'

export class OrcadInstanceLockError extends Error {
  constructor(
    readonly code: OrcadInstanceLockCode,
    message: string
  ) {
    super(message)
    this.name = 'OrcadInstanceLockError'
  }
}

export type OrcadDataRootPrivacyHooks = {
  platform?: NodeJS.Platform
  restrictWindowsDataRoot?: (dataRoot: string) => boolean
}

/** Repair owned directory permissions before refusing: roots contain credentials and session state. */
export function assertOrcadDataRootIsPrivate(
  dataRoot: string,
  hooks: OrcadDataRootPrivacyHooks
): void {
  // Windows synthesizes POSIX mode bits; restrict and verify real ACLs instead.
  if ((hooks.platform ?? process.platform) === 'win32') {
    const restrict =
      hooks.restrictWindowsDataRoot ?? ((path: string) => restrictWindowsPathSync(path, true))
    if (!restrict(dataRoot)) {
      throw new OrcadInstanceLockError(
        'orcad_data_root_shared',
        `Could not restrict the orcad data root ${dataRoot} to this user. orcad keeps ` +
          'private session and credential state there, so it refuses to start. Point ORCA_USER_DATA at a ' +
          'directory this account owns.'
      )
    }
    return
  }
  let stats
  try {
    stats = statSync(dataRoot)
  } catch (error) {
    throw new OrcadInstanceLockError(
      'orcad_data_root_unusable',
      `Cannot stat the orcad data root ${dataRoot}: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  const uid = process.getuid?.()
  if (uid !== undefined && stats.uid !== uid) {
    throw new OrcadInstanceLockError(
      'orcad_data_root_wrong_owner',
      `The orcad data root ${dataRoot} is owned by uid ${stats.uid}, not by uid ${uid} running ` +
        'this process. Give orcad its own data root (ORCA_USER_DATA) or chown this one.'
    )
  }
  if ((stats.mode & 0o077) === 0) {
    return
  }
  try {
    chmodSync(dataRoot, 0o700)
  } catch {
    // Re-stat to produce the actionable permission error.
  }
  let mode: number
  try {
    mode = statSync(dataRoot).mode
  } catch (error) {
    throw new OrcadInstanceLockError(
      'orcad_data_root_unusable',
      `Cannot stat the orcad data root ${dataRoot}: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  if ((mode & 0o077) !== 0) {
    throw new OrcadInstanceLockError(
      'orcad_data_root_shared',
      `The orcad data root ${dataRoot} is accessible to other users (mode ` +
        `${(mode & 0o777).toString(8)}) and could not be tightened. orcad keeps ` +
        'private session and credential state there, so it refuses to start. Run `chmod 700` on it, or point ORCA_USER_DATA ' +
        'at a private directory.'
    )
  }
}
