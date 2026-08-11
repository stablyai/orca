import { app, dialog, type BrowserWindow } from 'electron'
import { SCHEMA_VERSION } from '../../shared/constants'
import { compareAppVersions } from '../../shared/app-version'
import { assertLocalBuildCompatibility } from './local-build-compatibility'
import { loadLocalBuildCandidate, type LocalBuildCandidate } from './local-build-candidate'

export async function chooseLocalBuild(
  window: BrowserWindow | null
): Promise<LocalBuildCandidate | null> {
  const openDialogOptions: Electron.OpenDialogOptions = {
    title: 'Choose a Local Orca Build',
    buttonLabel: 'Choose Build',
    properties: ['openFile'],
    filters: [{ name: 'Orca update manifest', extensions: ['yml'] }]
  }
  const selection = await (window
    ? dialog.showOpenDialog(window, openDialogOptions)
    : dialog.showOpenDialog(openDialogOptions))
  const manifestPath = selection.filePaths[0]
  if (selection.canceled || !manifestPath) {
    return null
  }
  const candidate = await loadLocalBuildCandidate(manifestPath, process.arch)
  try {
    if (compareAppVersions(candidate.version, app.getVersion()) === 0) {
      throw new Error(
        'This build has the same version as the running app. Run pn build:mac again to create a uniquely versioned build.'
      )
    }
    const compatibility = await assertLocalBuildCompatibility(candidate.compatibility)
    const terminalSummary =
      compatibility.liveTerminalCount === 0
        ? 'No live terminals need to reconnect.'
        : `${compatibility.liveTerminalCount} live terminal${
            compatibility.liveTerminalCount === 1 ? '' : 's'
          } will reconnect after restart.`
    const messageBoxOptions: Electron.MessageBoxOptions = {
      type: 'question',
      title: 'Use Local Orca Build?',
      message: `${app.getVersion()} → ${candidate.version}`,
      detail: `${terminalSummary}\nWorkspace cards and settings are compatible with state schema ${SCHEMA_VERSION}.\n\nThe build must have the same valid code signature as Orca or installation will stop.`,
      buttons: ['Use Local Build', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      noLink: true
    }
    const confirmation = await (window
      ? dialog.showMessageBox(window, messageBoxOptions)
      : dialog.showMessageBox(messageBoxOptions))
    if (confirmation.response === 0) {
      return candidate
    }
  } catch (error) {
    await candidate.close()
    throw error
  }
  await candidate.close()
  return null
}
