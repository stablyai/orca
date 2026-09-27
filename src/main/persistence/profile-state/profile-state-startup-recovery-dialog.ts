import { statSync } from 'node:fs'
import type { MessageBoxOptions, MessageBoxReturnValue } from 'electron'
import { getActiveProfileStateLocation } from './profile-state-active-location'
import { profileStateDatabaseFiles } from './profile-state-storage-classification'

export type ProfileStateStartupRecoveryDialogDeps = {
  message: string
  recoveryCommand?: string
  showMessageBox: (options: MessageBoxOptions) => Promise<MessageBoxReturnValue>
  copyToClipboard: (text: string) => void
}

/** Present the only safe desktop recovery action without changing the failed authority. */
export async function presentProfileStateStartupRecoveryDialog(
  deps: ProfileStateStartupRecoveryDialogDeps
): Promise<void> {
  const buttons = deps.recoveryCommand ? ['Copy recovery command', 'Quit'] : ['Quit']
  const detail = deps.recoveryCommand
    ? `${deps.message}\n\nCopy the recovery command, then run it after Orca closes.`
    : `${deps.message}\n\nQuit Orca and resolve the profile-state authority before retrying.`
  const { response } = await deps.showMessageBox({
    type: 'error',
    buttons,
    defaultId: buttons.length - 1,
    cancelId: buttons.length - 1,
    title: 'Orca profile state cannot be opened',
    message: 'Orca cannot safely open this profile.',
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
    time === undefined ? '' : ` Last saved ${format(time)}.`
  const { response } = await deps.showMessageBox({
    type: 'warning',
    buttons: ['Use SQLite (Recommended)', 'Use JSON', 'Quit'],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
    title: 'Choose profile state',
    message: 'This profile has two saved copies that don’t match.',
    detail: [
      'This usually happens after opening the profile in an older version of Orca.',
      '',
      `SQLite: what this version of Orca saved. Changes made in the older version are discarded.${savedAt(deps.sqliteSavedAt)}`,
      '',
      `JSON: includes changes made in the older version. Changes this version saved since then are discarded.${savedAt(deps.jsonSavedAt)}`,
      '',
      'Orca archives both copies before switching, then restarts.'
    ].join('\n')
  })
  return response === 0 ? 'current-sqlite' : response === 1 ? 'current-json' : undefined
}
