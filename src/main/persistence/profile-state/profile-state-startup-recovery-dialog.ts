import { statSync } from 'node:fs'
import type { MessageBoxOptions, MessageBoxReturnValue } from 'electron'
import { getActiveProfileStateLocation } from './profile-state-active-location'
import { profileStateDatabaseFiles } from './profile-state-storage-classification'
import type { ProfileStateRepairSection } from './profile-state-section-repair'
import {
  includesProjectListSection,
  profileStateSectionLabels
} from './profile-state-section-labels'

// Why injected: profile-state tests run under Bun, where main-i18n (Electron, renderer catalogs) must not load.
export type ProfileStateDialogTranslate = (
  key: string,
  englishFallback: string,
  options?: Record<string, string>
) => string

export type ProfileStateStartupRecoveryDialogDeps = {
  message: string
  recoveryCommand?: string
  showMessageBox: (options: MessageBoxOptions) => Promise<MessageBoxReturnValue>
  copyToClipboard: (text: string) => void
  translate: ProfileStateDialogTranslate
}

/** Present recovery without mutating the failed authority. */
export async function presentProfileStateStartupRecoveryDialog(
  deps: ProfileStateStartupRecoveryDialogDeps
): Promise<void> {
  const quit = deps.translate('profileState.startupRecovery.quitButton', 'Quit')
  const buttons = deps.recoveryCommand
    ? [
        deps.translate('profileState.startupRecovery.copyCommandButton', 'Copy recovery command'),
        quit
      ]
    : [quit]
  const nextStep = deps.recoveryCommand
    ? deps.translate(
        'profileState.startupRecovery.copyCommandDetail',
        'Copy the recovery command, then run it after Orca closes.'
      )
    : deps.translate(
        'profileState.startupRecovery.quitDetail',
        'Quit Orca and resolve the profile-state authority before retrying.'
      )
  const detail = `${deps.message}\n\n${nextStep}`
  const { response } = await deps.showMessageBox({
    type: 'error',
    buttons,
    defaultId: buttons.length - 1,
    cancelId: buttons.length - 1,
    title: deps.translate(
      'profileState.startupRecovery.title',
      'Orca profile state cannot be opened'
    ),
    message: deps.translate(
      'profileState.startupRecovery.message',
      'Orca cannot safely open this profile.'
    ),
    detail
  })
  if (response === 0 && deps.recoveryCommand) {
    deps.copyToClipboard(deps.recoveryCommand)
  }
}

export type ProfileStateCopyChoice = 'current-sqlite' | 'current-json'

export type ProfileStateCopyChoiceDialogDeps = {
  sqliteSavedAt?: Date
  jsonSavedAt?: Date
  formatTime?: (time: Date) => string
  showMessageBox: (options: MessageBoxOptions) => Promise<MessageBoxReturnValue>
  translate: ProfileStateDialogTranslate
}

/** Best effort: WAL can hold the latest commit; shm mtimes reflect opens, not saves. */
export function readProfileStateCopySavedTimes(userDataPath: string): {
  sqliteSavedAt?: Date
  jsonSavedAt?: Date
} {
  try {
    const location = getActiveProfileStateLocation(userDataPath)
    if (location === undefined) {
      return {}
    }
    const sqliteTimes = profileStateDatabaseFiles(location.databaseFile)
      .filter((path) => !path.endsWith('-shm'))
      .map(modifiedAt)
      .filter((time) => time !== undefined)
    const sqliteSavedAt =
      sqliteTimes.length === 0 ? undefined : new Date(Math.max(...sqliteTimes.map(Number)))
    const jsonSavedAt = modifiedAt(location.dataFile)
    return {
      ...(sqliteSavedAt === undefined ? {} : { sqliteSavedAt }),
      ...(jsonSavedAt === undefined ? {} : { jsonSavedAt })
    }
  } catch {
    return {}
  }
}

function modifiedAt(path: string): Date | undefined {
  return statSync(path, { throwIfNoEntry: false })?.mtime
}

/** Undefined quits without changing either diverged copy. */
export async function chooseProfileStateCopy(
  deps: ProfileStateCopyChoiceDialogDeps
): Promise<ProfileStateCopyChoice | undefined> {
  const format = deps.formatTime ?? ((time: Date) => time.toLocaleString())
  const savedAt = (time: Date | undefined): string =>
    time === undefined
      ? ''
      : ` ${deps.translate('profileState.copyChoice.lastSaved', 'Last saved {{time}}.', { time: format(time) })}`
  const { response } = await deps.showMessageBox({
    type: 'warning',
    buttons: [
      deps.translate('profileState.copyChoice.useSqliteButton', 'Use SQLite (Recommended)'),
      deps.translate('profileState.copyChoice.useJsonButton', 'Use JSON'),
      deps.translate('profileState.copyChoice.quitButton', 'Quit')
    ],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
    title: deps.translate('profileState.copyChoice.title', 'Choose profile state'),
    message: deps.translate(
      'profileState.copyChoice.message',
      'This profile has two saved copies that don’t match.'
    ),
    detail: [
      deps.translate(
        'profileState.copyChoice.cause',
        'This usually happens after opening the profile in an older version of Orca.'
      ),
      '',
      deps.translate(
        'profileState.copyChoice.sqliteOption',
        'SQLite: what this version of Orca saved. Changes made in the older version are discarded.'
      ) + savedAt(deps.sqliteSavedAt),
      '',
      deps.translate(
        'profileState.copyChoice.jsonOption',
        'JSON: includes changes made in the older version. Changes this version saved since then are discarded.'
      ) + savedAt(deps.jsonSavedAt),
      '',
      deps.translate(
        'profileState.copyChoice.archiveNote',
        'Orca archives both copies before switching, then restarts.'
      )
    ].join('\n')
  })
  return response === 0 ? 'current-sqlite' : response === 1 ? 'current-json' : undefined
}

export type ProfileStateRepairChoiceDialogDeps = {
  sections: readonly ProfileStateRepairSection[]
  formatTime?: (time: Date) => string
  showMessageBox: (options: MessageBoxOptions) => Promise<MessageBoxReturnValue>
  translate: ProfileStateDialogTranslate
}

/** Confirm replacement with older sections; false quits unchanged. */
export async function chooseProfileStateRepair(
  deps: ProfileStateRepairChoiceDialogDeps
): Promise<boolean> {
  const format = deps.formatTime ?? ((time: Date) => time.toLocaleString())
  const lines = deps.sections.map(({ domain, backupCreatedAtMs }) => {
    const [section] = profileStateSectionLabels([domain], deps.translate)
    return backupCreatedAtMs === undefined
      ? deps.translate(
          'profileState.repairChoice.sectionStartsEmpty',
          '{{section}}: no readable backup, so it will start empty.',
          { section }
        )
      : deps.translate(
          'profileState.repairChoice.sectionRestored',
          '{{section}}: restored from the backup saved {{time}}.',
          { section, time: format(new Date(backupCreatedAtMs)) }
        )
  })
  const projectSections = deps.sections.filter(({ domain }) => includesProjectListSection([domain]))
  const projectNote =
    projectSections.length === 0
      ? []
      : projectSections.some(({ backupCreatedAtMs }) => backupCreatedAtMs === undefined)
        ? [
            deps.translate(
              'profileState.repairChoice.projectsForgotten',
              'Orca will forget your projects and their workspace details. Files on disk are not touched.'
            ),
            ''
          ]
        : [
            deps.translate(
              'profileState.repairChoice.newerProjectsRemoved',
              'Projects added after that backup will be removed from Orca, along with their workspace details. Files on disk are not touched.'
            ),
            ''
          ]
  const { response } = await deps.showMessageBox({
    type: 'warning',
    buttons: [
      deps.translate('profileState.repairChoice.repairButton', 'Repair and Restart'),
      deps.translate('profileState.repairChoice.quitButton', 'Quit')
    ],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
    title: deps.translate('profileState.repairChoice.title', 'Repair profile'),
    message: deps.translate(
      'profileState.repairChoice.message',
      "Part of this profile's saved state is damaged."
    ),
    detail: [
      ...new Set(lines),
      '',
      deps.translate(
        'profileState.repairChoice.restUnchanged',
        'Everything else stays as it is now.'
      ),
      '',
      ...projectNote,
      deps.translate(
        'profileState.repairChoice.damagedCopyKept',
        'Orca keeps a copy of the damaged file in its data folder, then restarts.'
      )
    ].join('\n')
  })
  return response === 0
}
