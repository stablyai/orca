import { statSync } from 'node:fs'
import type { MessageBoxOptions, MessageBoxReturnValue } from 'electron'
import { getActiveProfileStateLocation } from './profile-state-active-location'
import { profileStateDatabaseFiles } from './profile-state-storage-classification'

// Why injected: profile-state tests run under Bun, where main-i18n (Electron, renderer catalogs) must not load.
export type ProfileStateDialogTranslate = (
  key: string,
  englishFallback: string,
  options?: { time: string }
) => string

export type ProfileStateStartupRecoveryDialogDeps = {
  message: string
  recoveryCommand?: string
  showMessageBox: (options: MessageBoxOptions) => Promise<MessageBoxReturnValue>
  copyToClipboard: (text: string) => void
  translate: ProfileStateDialogTranslate
}

/** Present the only safe desktop recovery action without changing the failed authority. */
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

/** Best-effort save times; SQLite's latest commit may live only in its WAL, and -shm changes on every open. */
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

/** Ask which diverged copy to keep; undefined means quit without changing either. */
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
