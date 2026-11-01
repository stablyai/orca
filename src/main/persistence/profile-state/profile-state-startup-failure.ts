import { profileStateSectionLabels } from './profile-state-section-labels'
import type { ProfileStateDialogTranslate } from './profile-state-startup-recovery-dialog'

// Logs keep English; dialogs pass translateMain.
const english: ProfileStateDialogTranslate = (_key, fallback, options) =>
  fallback.replace(/\{\{(\w+)\}\}/g, (slot, name: string) =>
    options && Object.hasOwn(options, name) ? options[name] : slot
  )

type ProfileStateRecoveryFailure = {
  code: 'profile-state-recovery-required'
  dataFile: string
  databaseFile: string
  exportPaths: readonly string[]
  backupPaths?: readonly string[]
  profileId?: unknown
  repairableSections?: unknown
}

type ProfileStateAuthorityFailure = {
  code: 'ambiguous-profile-state'
  message: string
  divergence?: unknown
}

export type ProfileStateStartupFailureClass =
  | 'recovery-required'
  | 'ambiguous-authority'
  | 'revision-conflict'
  | 'writer-unavailable'
  | 'newer-schema'
  | 'publication-unavailable'

export function profileStateStartupFailureClass(
  error: unknown
): ProfileStateStartupFailureClass | undefined {
  if (isProfileStateRecoveryFailure(error)) {
    return 'recovery-required'
  }
  if (isProfileStateAuthorityFailure(error)) {
    return 'ambiguous-authority'
  }
  if (isRecord(error) && typeof error.code === 'string') {
    if (error.code === 'profile-state-publication-unavailable') {
      return 'publication-unavailable'
    }
    if (error.code === 'newer-schema') {
      return 'newer-schema'
    }
    if (error.code === 'profile-state-revision-conflict') {
      return 'revision-conflict'
    }
    if (error.code.startsWith('profile-state-writer-')) {
      return 'writer-unavailable'
    }
  }
  return undefined
}

export function isDivergedProfileStateFailure(error: unknown): boolean {
  return isProfileStateAuthorityFailure(error) && error.divergence === 'diverged-json'
}

export function formatProfileStateStartupFailure(
  error: unknown,
  translate: ProfileStateDialogTranslate = english
): string | undefined {
  if (isProfileStateRecoveryFailure(error)) {
    const noneFound = `  ${translate('profileState.startupFailure.noneFound', '(none found)')}`
    const retainedBackups = !error.backupPaths?.length
      ? noneFound
      : error.backupPaths.map((path) => `  ${path}`).join('\n')
    const retainedExports =
      error.exportPaths.length === 0
        ? noneFound
        : error.exportPaths.map((path) => `  ${path}`).join('\n')
    const sqlitePath = translate(
      'profileState.startupFailure.sqlitePath',
      'SQLite path: {{path}}',
      { path: error.databaseFile }
    )
    const damagedSections = repairableSectionDomains(error)
    if (damagedSections !== undefined && typeof error.profileId === 'string') {
      return [
        translate(
          'profileState.startupFailure.sectionsDamaged',
          "Part of this profile's saved state is damaged: {{sections}}. Everything else is intact.",
          {
            sections: profileStateSectionLabels(damagedSections, translate).join(', ')
          }
        ),
        translate(
          'profileState.startupFailure.repairCommand',
          'Stop Orca, then run `{{command}}` to replace only the damaged parts from backups and keep everything else. Orca keeps a copy of the damaged file.',
          {
            command: `orca profile state rollback --repair --profile-id ${error.profileId}`
          }
        ),
        sqlitePath,
        translate(
          'profileState.startupFailure.restoreWholeBackup',
          'To restore a whole backup instead, run `{{exportsCommand}}`, then `{{rollbackCommand}}`.',
          {
            exportsCommand: 'orca profile state exports',
            rollbackCommand: 'orca profile state rollback --backup <id>'
          }
        )
      ].join('\n')
    }
    return [
      translate(
        'profileState.startupFailure.sqliteUnreadable',
        'Orca cannot safely open the active profile because its SQLite state is unreadable.'
      ),
      translate('profileState.startupFailure.legacyJsonPath', 'Legacy JSON path: {{path}}', {
        path: error.dataFile
      }),
      sqlitePath,
      translate('profileState.startupFailure.retainedBackups', 'Retained SQLite backups:'),
      retainedBackups,
      translate('profileState.startupFailure.retainedExports', 'Retained JSON exports:'),
      retainedExports,
      translate(
        'profileState.startupFailure.chooseRecoveryArtifact',
        'Stop Orca, then run `{{command}}` and choose a known-good recovery artifact.',
        { command: 'orca profile state exports' }
      ),
      translate(
        'profileState.startupFailure.restoreCommands',
        'Restore SQLite with `{{backupCommand}}`, or restore a JSON export with `{{revisionCommand}}`.',
        {
          backupCommand: 'orca profile state rollback --backup <id>',
          revisionCommand: 'orca profile state rollback --revision <revision>'
        }
      )
    ].join('\n')
  }

  if (isProfileStateAuthorityFailure(error)) {
    return [
      translate(
        'profileState.startupFailure.authorityAmbiguous',
        'Orca cannot safely choose a profile-state authority: {{detail}}',
        { detail: error.message }
      ),
      translate(
        'profileState.startupFailure.authorityBothPreserved',
        'An older build may have changed the JSON file. Both copies are preserved; neither is selected automatically.'
      ),
      translate(
        'profileState.startupFailure.authorityCopyFirst',
        'Stop Orca and copy the profile directory before choosing which state to keep.'
      ),
      translate(
        'profileState.startupFailure.authorityKeepJson',
        'To keep the current JSON, including edits from an older build, run `{{command}}`. This archives both copies and does not merge their contents.',
        { command: 'orca profile state rollback --current-json' }
      ),
      translate(
        'profileState.startupFailure.authorityInspect',
        'Run `{{command}}` to inspect retained recovery points.',
        { command: 'orca profile state exports' }
      ),
      translate(
        'profileState.startupFailure.authorityRestore',
        'Use `{{backupCommand}}` or `{{revisionCommand}}` only after selecting the state you want to restore.',
        {
          backupCommand: 'orca profile state rollback --backup <id>',
          revisionCommand: 'orca profile state rollback --revision <revision>'
        }
      )
    ].join('\n')
  }

  const failureClass = profileStateStartupFailureClass(error)
  if (failureClass === 'publication-unavailable' && isRecord(error)) {
    if (typeof error.directory === 'string') {
      return profileStatePublicationFailureText(error.directory, translate)
    }
    if (typeof error.message === 'string') {
      return error.message
    }
  }
  if (failureClass === 'newer-schema') {
    return translate(
      'profileState.startupFailure.newerSchema',
      'This profile was saved by a newer version of Orca. Open it with that version or a newer release. Your profile has not been changed.'
    )
  }
  if (failureClass === 'revision-conflict') {
    return translate(
      'profileState.startupFailure.revisionConflict',
      'The active profile changed while Orca was starting. Close other Orca processes using this profile, then restart Orca.'
    )
  }
  if (failureClass === 'writer-unavailable') {
    return translate(
      'profileState.startupFailure.writerUnavailable',
      'Orca could not start profile persistence. Restart Orca; if the problem continues, repair or reinstall this build.'
    )
  }

  return undefined
}

/** Shared by the error's English message and the localized startup dialog. */
export function profileStatePublicationFailureText(
  directory: string,
  translate: ProfileStateDialogTranslate = english
): string {
  return [
    translate(
      'profileState.startupFailure.publicationUnavailable',
      'Orca could not safely publish profile state in {{directory}}.',
      { directory }
    ),
    translate(
      'profileState.startupFailure.publicationNeedsHardLinks',
      'This location must support hard links, and Orca needs permission to create them.'
    ),
    translate(
      'profileState.startupFailure.publicationMoveData',
      'Close Orca and orcad before checking folder permissions or moving the complete Orca data directory to a writable local filesystem that supports hard links, such as APFS, NTFS, or ext4.'
    ),
    translate(
      'profileState.startupFailure.publicationKeepFiles',
      'Keep the original directory and all recovery files.'
    )
  ].join('\n')
}

function isProfileStateRecoveryFailure(error: unknown): error is ProfileStateRecoveryFailure {
  return (
    isRecord(error) &&
    error.code === 'profile-state-recovery-required' &&
    typeof error.dataFile === 'string' &&
    typeof error.databaseFile === 'string' &&
    Array.isArray(error.exportPaths) &&
    error.exportPaths.every((path) => typeof path === 'string') &&
    (error.backupPaths === undefined ||
      (Array.isArray(error.backupPaths) &&
        error.backupPaths.every((path) => typeof path === 'string')))
  )
}

function repairableSectionDomains(error: ProfileStateRecoveryFailure): string[] | undefined {
  const sections = error.repairableSections
  if (!Array.isArray(sections) || sections.length === 0) {
    return undefined
  }
  const domains = sections.map((section: unknown) =>
    isRecord(section) && typeof section.domain === 'string' ? section.domain : undefined
  )
  return domains.every((domain): domain is string => domain !== undefined) ? domains : undefined
}

function isProfileStateAuthorityFailure(error: unknown): error is ProfileStateAuthorityFailure {
  return (
    isRecord(error) && error.code === 'ambiguous-profile-state' && typeof error.message === 'string'
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
