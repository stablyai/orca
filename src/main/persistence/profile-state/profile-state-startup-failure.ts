import { profileStateSectionLabels } from './profile-state-section-labels'

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

export function formatProfileStateStartupFailure(error: unknown): string | undefined {
  if (isProfileStateRecoveryFailure(error)) {
    const retainedBackups = !error.backupPaths?.length
      ? '  (none found)'
      : error.backupPaths.map((path) => `  ${path}`).join('\n')
    const retainedExports =
      error.exportPaths.length === 0
        ? '  (none found)'
        : error.exportPaths.map((path) => `  ${path}`).join('\n')
    const damagedSections = repairableSectionDomains(error)
    if (damagedSections !== undefined && typeof error.profileId === 'string') {
      return [
        `Part of this profile's saved state is damaged: ${profileStateSectionLabels(damagedSections).join(', ')}. Everything else is intact.`,
        `Stop Orca, then run \`orca profile state rollback --repair --profile-id ${error.profileId}\` to replace only the damaged parts from backups and keep everything else. Orca keeps a copy of the damaged file.`,
        `SQLite path: ${error.databaseFile}`,
        'To restore a whole backup instead, run `orca profile state exports`, then `orca profile state rollback --backup <id>`.'
      ].join('\n')
    }
    return [
      'Orca cannot safely open the active profile because its SQLite state is unreadable.',
      `Legacy JSON path: ${error.dataFile}`,
      `SQLite path: ${error.databaseFile}`,
      'Retained SQLite backups:',
      retainedBackups,
      'Retained JSON exports:',
      retainedExports,
      'Stop Orca, then run `orca profile state exports` and choose a known-good recovery artifact.',
      'Restore SQLite with `orca profile state rollback --backup <id>`, or restore a JSON export with',
      '`orca profile state rollback --revision <revision>`.'
    ].join('\n')
  }

  if (isProfileStateAuthorityFailure(error)) {
    return [
      `Orca cannot safely choose a profile-state authority: ${error.message}`,
      'An older build may have changed the JSON file. Both copies are preserved; neither is selected automatically.',
      'Stop Orca and copy the profile directory before choosing which state to keep.',
      'To keep the current JSON, including edits from an older build, run `orca profile state rollback --current-json`. This archives both copies and does not merge their contents.',
      'Run `orca profile state exports` to inspect retained recovery points.',
      'Use `orca profile state rollback --backup <id>` or `orca profile state rollback --revision <revision>` only after selecting the state you want to restore.'
    ].join('\n')
  }

  const failureClass = profileStateStartupFailureClass(error)
  if (
    failureClass === 'publication-unavailable' &&
    isRecord(error) &&
    typeof error.message === 'string'
  ) {
    return error.message
  }
  if (failureClass === 'newer-schema') {
    return 'This profile was saved by a newer version of Orca. Open it with that version or a newer release. Your profile has not been changed.'
  }
  if (failureClass === 'revision-conflict') {
    return 'The active profile changed while Orca was starting. Close other Orca processes using this profile, then restart Orca.'
  }
  if (failureClass === 'writer-unavailable') {
    return 'Orca could not start profile persistence. Restart Orca; if the problem continues, repair or reinstall this build.'
  }

  return undefined
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
