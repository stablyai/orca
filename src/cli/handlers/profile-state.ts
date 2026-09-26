import type { CommandHandler } from '../dispatch'
import { printResult } from '../format'
import { rejectRemoteSelectionFlags } from '../remote-selection-flag-rejection'
import {
  getDefaultUserDataPath,
  RuntimeClientError,
  type RuntimeClient,
  type RuntimeRpcSuccess
} from '../runtime-client'
import {
  getProfileStateExports,
  rollbackProfileState
} from '../../main/persistence/profile-state/profile-state-recovery-command'
import { acquireProfileStateMaintenance } from '../../main/persistence/profile-state/profile-state-access'
import {
  isProfileStateRecoveryCommandError,
  type ProfileStateExportsResult,
  type ProfileStateRollbackResult,
  type ProfileStateRecoverySelector
} from '../../shared/profile-state-recovery-command'
import {
  canLaunchProfileStateRecovery,
  launchProfileStateRecovery
} from '../runtime/profile-state-recovery-launch'

function localSuccess<TResult>(result: TResult): RuntimeRpcSuccess<TResult> {
  return {
    id: 'local',
    ok: true,
    result,
    _meta: { runtimeId: 'local' }
  }
}

function formatExports(result: ProfileStateExportsResult): string {
  return [
    `profileId: ${result.profileId}`,
    `dataFile: ${result.dataFile}`,
    `databaseFile: ${result.databaseFile}`,
    'JSON exports:',
    ...(result.exportPaths.length > 0 ? result.exportPaths : ['(none)']),
    'SQLite backups:',
    ...(result.backups.length > 0
      ? result.backups.map((backup) => `${backup.id}: ${backup.path}`)
      : ['(none)'])
  ].join('\n')
}

function formatRollback(result: ProfileStateRollbackResult): string {
  return [
    `profileId: ${result.profileId}`,
    result.revision === null ? 'source: current JSON' : `revision: ${result.revision}`,
    `storage: ${result.storage}`,
    `restored: ${result.restoredPath}`,
    `quarantine: ${result.quarantineDirectory}`,
    `removedDatabaseFiles: ${result.removedDatabaseFiles.length}`
  ].join('\n')
}

function rejectProfileStateRemoteSelection(flags: ReadonlyMap<string, string | boolean>): void {
  rejectRemoteSelectionFlags(
    flags,
    "profile-state recovery; it operates on this machine's active profile."
  )
}

async function requireStoppedRuntime(client: RuntimeClient): Promise<void> {
  const status = await client.getCliStatus()
  if (status.result.runtime.reachable || status.result.app.running) {
    throw new RuntimeClientError(
      'runtime_error',
      'Stop Orca before profile-state rollback so no process can write the SQLite database.'
    )
  }
}

function parseRevision(flags: Map<string, string | boolean>): number {
  const rawRevision = flags.get('revision')
  if (typeof rawRevision !== 'string' || rawRevision.length === 0) {
    throw new RuntimeClientError('invalid_argument', 'Profile-state rollback requires --revision.')
  }
  const revision = Number(rawRevision)
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new RuntimeClientError(
      'invalid_argument',
      `Invalid profile-state revision: ${rawRevision}`
    )
  }
  return revision
}

export const PROFILE_STATE_HANDLERS: Record<string, CommandHandler> = {
  'profile state exports': async ({ flags, json }) => {
    rejectProfileStateRemoteSelection(flags)
    const result = translateRecoveryError(() => getProfileStateExports(getDefaultUserDataPath()))
    printResult(localSuccess(result), json, formatExports)
  },
  'profile state rollback': async ({ client, flags, json }) => {
    rejectProfileStateRemoteSelection(flags)
    const selector = parseSelector(flags)
    const userDataPath = getDefaultUserDataPath()
    let result: ProfileStateRollbackResult
    if (canLaunchProfileStateRecovery()) {
      await requireStoppedRuntime(client)
      result = await launchProfileStateRecovery({ userDataPath, selector })
    } else {
      const maintenance = acquireProfileStateMaintenance(userDataPath)
      try {
        await requireStoppedRuntime(client)
        result = translateRecoveryError(() =>
          rollbackProfileState(userDataPath, selector, maintenance)
        )
      } finally {
        maintenance.release()
      }
    }
    printResult(localSuccess(result), json, formatRollback)
  }
}

function parseSelector(flags: Map<string, string | boolean>): ProfileStateRecoverySelector {
  if (['revision', 'backup', 'current-json'].filter((flag) => flags.has(flag)).length !== 1) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Select exactly one of --revision, --backup, or --current-json.'
    )
  }
  if (flags.has('current-json')) {
    if (flags.get('current-json') !== true) {
      throw new RuntimeClientError('invalid_argument', '--current-json does not take a value.')
    }
    return { kind: 'current-json' }
  }
  if (!flags.has('backup')) {
    return { kind: 'json', revision: parseRevision(flags) }
  }
  const backupId = flags.get('backup')
  if (typeof backupId !== 'string' || backupId.length === 0) {
    throw new RuntimeClientError('invalid_argument', 'Profile-state rollback requires --backup.')
  }
  return { kind: 'sqlite', backupId }
}

function translateRecoveryError<T>(operation: () => T): T {
  try {
    return operation()
  } catch (error) {
    if (isProfileStateRecoveryCommandError(error)) {
      throw new RuntimeClientError(error.code, error.message)
    }
    throw error
  }
}
